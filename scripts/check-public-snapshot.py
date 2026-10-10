#!/usr/bin/env python3
"""Reject excluded content, common credential patterns, or unexpected Git identities."""

from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path


EXPECTED_EMAIL = "2824906+serge-ivo@users.noreply.github.com"
EXPECTED_NAME = "serge-ivo"
ROOT = Path(__file__).resolve().parents[1]
FORBIDDEN_PATHS = (
    "docs/source-material/",
    "web/dist/",
)
FORBIDDEN_NAMES = (".env",)
SECRET_PATTERNS = (
    re.compile(rb"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----"),
    re.compile(rb"\bAKIA[0-9A-Z]{16}\b"),
    re.compile(rb"\bgh[pousr]_[A-Za-z0-9]{20,}\b"),
    re.compile(rb"\bsk-[A-Za-z0-9_-]{20,}\b"),
    re.compile(
        rb"(?i)\b(?:api[_-]?(?:key|secret)|access[_-]?token|client[_-]?secret|password)\b"
        rb"\s*[:=]\s*[\"'][^\"']{8,}[\"']"
    ),
    re.compile(rb"https?://[^/\s:@]+:[^/\s@]+@"),
)


def git(*args: str) -> str:
    return subprocess.check_output(["git", *args], cwd=ROOT, text=True).strip()


def committed_paths(commit_id: str) -> list[str]:
    raw = subprocess.check_output(
        ["git", "ls-tree", "-r", "--name-only", "-z", commit_id], cwd=ROOT
    )
    return [path.decode("utf-8", errors="surrogateescape") for path in raw.split(b"\0") if path]


def main() -> int:
    errors: list[str] = []
    tracked = [p for p in git("ls-files").splitlines() if p]

    for path in tracked:
        if any(path.startswith(prefix) for prefix in FORBIDDEN_PATHS):
            errors.append("excluded content is tracked")
            break
        name = Path(path).name
        if name.startswith(FORBIDDEN_NAMES) or "/node_modules/" in f"/{path}/":
            errors.append("environment or dependency content is tracked")
            break

    for path in tracked:
        try:
            content = (ROOT / path).read_bytes()
        except OSError:
            continue
        if any(pattern.search(content) for pattern in SECRET_PATTERNS):
            errors.append("a common credential pattern was found in tracked content")
            break

    commit_ids = git("log", "--all", "--format=%H").splitlines()
    for commit_id in commit_ids:
        tree_paths = committed_paths(commit_id)
        for path in tree_paths:
            if any(path.startswith(prefix) for prefix in FORBIDDEN_PATHS):
                errors.append("excluded content is present in a commit tree")
                break
            name = Path(path).name
            if name.startswith(FORBIDDEN_NAMES) or "/node_modules/" in f"/{path}/":
                errors.append("environment or dependency content is present in a commit tree")
                break
            content = subprocess.check_output(
                ["git", "show", f"{commit_id}:{path}"], cwd=ROOT
            )
            if any(pattern.search(content) for pattern in SECRET_PATTERNS):
                errors.append("a common credential pattern was found in a commit tree")
                break
        if errors:
            break
        metadata = subprocess.check_output(
            ["git", "show", "-s", "--format=%an%x1f%ae%x1f%cn%x1f%ce%x1f%B", commit_id],
            cwd=ROOT,
            text=True,
        )
        fields = metadata.split("\x1f", 4)
        author_name, author_email, committer_name, committer_email, message = fields
        if (
            author_name != EXPECTED_NAME
            or author_email != EXPECTED_EMAIL
            or committer_name != EXPECTED_NAME
            or committer_email != EXPECTED_EMAIL
        ):
            errors.append("a commit has an unexpected raw author or committer identity")
            break
        trailers = subprocess.run(
            ["git", "interpret-trailers", "--parse"],
            cwd=ROOT,
            input=message,
            text=True,
            capture_output=True,
            check=True,
        ).stdout
        trailer_emails = re.findall(r"[\w.+-]+@[\w.-]+", trailers)
        if any(email != EXPECTED_EMAIL for email in trailer_emails):
            errors.append("a commit trailer contains an unexpected email address")
            break
        raw_commit = subprocess.check_output(
            ["git", "cat-file", "commit", commit_id], cwd=ROOT
        )
        if any(pattern.search(raw_commit) for pattern in SECRET_PATTERNS):
            errors.append("a commit object contains a common credential pattern")
            break

    if errors:
        for error in dict.fromkeys(errors):
            print(f"FAIL: {error}", file=sys.stderr)
        return 1
    print(f"Public snapshot check passed ({len(tracked)} tracked files).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

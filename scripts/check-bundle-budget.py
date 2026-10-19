#!/usr/bin/env python3
"""Fails when the gzipped web bundle exceeds the budgets in docs/performance-budgets.json (issue #35).

Run after `pnpm --filter @tennis-clubs/web build`. The default directory is web/dist/assets; another directory can be
given as the first argument.
"""

import gzip
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BUDGETS_FILE = ROOT / "docs" / "performance-budgets.json"
KINDS = {".js": "js", ".css": "css"}


def measure(assets: Path) -> dict[str, float]:
    """Gzipped size in KB of each budgeted kind of asset, summed over the directory."""
    totals = {kind: 0 for kind in KINDS.values()}
    for path in sorted(assets.iterdir()):
        kind = KINDS.get(path.suffix)
        if kind:
            totals[kind] += len(gzip.compress(path.read_bytes(), compresslevel=9))
    return {kind: total / 1024 for kind, total in totals.items()}


def over_budget(sizes: dict[str, float], budgets: dict[str, float]) -> list[str]:
    return [
        f"{kind}: {sizes[kind]:.1f} KB gzipped exceeds the {budgets[kind]} KB budget"
        for kind in budgets
        if sizes[kind] > budgets[kind]
    ]


def main(argv: list[str]) -> int:
    assets = Path(argv[1]) if len(argv) > 1 else ROOT / "web" / "dist" / "assets"
    if not assets.is_dir():
        print(f"No build output at {assets}. Run: pnpm --filter @tennis-clubs/web build")
        return 1
    budgets = json.loads(BUDGETS_FILE.read_text())["bundle_gzip_kb"]
    sizes = measure(assets)
    for kind, budget in budgets.items():
        print(f"{kind}: {sizes[kind]:.1f} KB gzipped (budget {budget} KB)")
    failures = over_budget(sizes, budgets)
    for failure in failures:
        print(f"FAIL {failure}")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))

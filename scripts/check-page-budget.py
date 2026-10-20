#!/usr/bin/env python3
"""Fails when a page's measured cost exceeds its budget in docs/performance-budgets.json (issue #30).

A page's cost is the sum of the median latency of the actions it issues, measured on the seeded association
(tests/association_seed.py) in an in-memory SQLite database with every migration applied. The page calls are defined
here, next to the check, and the budgets live in the JSON file; tests/test_page_budgets.py keeps the two in step.

Usage: check-page-budget.py [budgets.json] [--runs N] [--json]
Exit status: 0 when every page is within budget, 1 when any page exceeds it, 2 when the budget file is malformed.
"""

import json
import sqlite3
import statistics
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tests"))

from association_seed import VIEWER, seed_association  # noqa: E402
from mcp_harness import connect  # noqa: E402

MIGRATIONS = json.loads((ROOT / "migrations.json").read_text())["migrations"]
TOOLS = {tool["name"]: tool for tool in json.loads((ROOT / "mcp.json").read_text())["tools"]}
DEFAULT_BUDGETS = ROOT / "docs" / "performance-budgets.json"

FROM = "2026-10-20T00:00:00+11:00"
MEMBER = {"__user_id": VIEWER, "from": FROM, "limit": 50, "offset": 0, "date_from": "", "to": "", "season_id": "", "team_id": "", "result_status": "", "mode": "upcoming"}
ADMIN = {"__user_id": "club-000-admin", "org_id": "club-000", "limit": 100, "offset": 0}
# Each page is the ordered list of its server calls. Roster lookup uses the viewer's first fixture in the seed.
PAGE_CALLS = {
    "fixtures": [
        ("list_my_fixtures", MEMBER),
        ("list_fixture_roster", {"__user_id": VIEWER, "fixture_id": "club-000-s2-d0-f000", "limit": 50, "offset": 0}),
    ],
    "directory": [
        ("list_club_venues", ADMIN),
        ("list_club_teams", {**ADMIN, "division_id": None}),
    ],
}


def load_budgets(path):
    try:
        budgets = json.loads(Path(path).read_text(encoding="utf-8"))
        pages = budgets["pages"]
        return {name: float(spec["budget_ms"]) for name, spec in pages.items()}
    except (OSError, ValueError, KeyError, TypeError) as error:
        raise ValueError(f"malformed budget file {path}: {error}") from error


def median_ms(db, tool, params, runs):
    sql = TOOLS[tool]["sql"]
    db.execute(sql, params).fetchall()  # warm-up
    timings = []
    for _ in range(runs):
        started = time.perf_counter()
        db.execute(sql, params).fetchall()
        timings.append((time.perf_counter() - started) * 1000)
    return statistics.median(timings)


def measure(runs):
    db = connect()
    db.row_factory = sqlite3.Row
    for migration in MIGRATIONS:
        db.executescript(migration["sql"])
    seed_association(db)
    measured = {}
    for page, calls in PAGE_CALLS.items():
        measured[page] = sum(median_ms(db, tool, params, runs) for tool, params in calls)
    db.close()
    return measured


def main(argv):
    runs = 7
    as_json = "--json" in argv
    if "--runs" in argv:
        runs = int(argv[argv.index("--runs") + 1])
    positional = [arg for arg in argv[1:] if not arg.startswith("--") and not arg.isdigit()]
    budget_path = Path(positional[0]) if positional else DEFAULT_BUDGETS
    try:
        budgets = load_budgets(budget_path)
    except ValueError as error:
        print(error)
        return 2
    missing = sorted(set(PAGE_CALLS) ^ set(budgets))
    if missing:
        print(f"pages in the budget file and in the check disagree: {', '.join(missing)}")
        return 2
    measured = measure(runs)
    failures = {page: (measured[page], budgets[page]) for page in budgets if measured[page] > budgets[page]}
    if as_json:
        print(json.dumps({"pages": {page: {"median_ms": round(measured[page], 1), "budget_ms": budgets[page]} for page in budgets}, "failures": sorted(failures)}, indent=2))
    else:
        for page in sorted(budgets):
            status = "FAIL" if page in failures else "ok"
            print(f"{status:4} {page}: median {measured[page]:.1f} ms (budget {budgets[page]:.0f} ms)")
        for page, (cost, budget) in sorted(failures.items()):
            print(f"FAIL {page}: {cost:.1f} ms exceeds the {budget:.0f} ms budget")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))

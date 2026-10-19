import json
import sqlite3
import statistics
import time
import unittest
from pathlib import Path

from association_seed import VIEWER, seed_association
from mcp_harness import connect

# Query budgets for the fixture and directory views at association scale (issue #35). Budgets live in
# docs/performance-budgets.json; docs/performance-budgets.md explains how they were chosen and how to change them.
ROOT = Path(__file__).resolve().parents[1]
MIGRATIONS = json.loads((ROOT / "migrations.json").read_text())["migrations"]
TOOLS = {tool["name"]: tool for tool in json.loads((ROOT / "mcp.json").read_text())["tools"]}
BUDGETS = json.loads((ROOT / "docs" / "performance-budgets.json").read_text())
DOC = (ROOT / "docs" / "performance-budgets.md").read_text()

FROM = "2026-10-20T00:00:00+11:00"
RUNS = 7
MY_FIXTURES = {"__user_id": VIEWER, "from": FROM, "limit": 50, "offset": 0, "date_from": "", "to": "", "season_id": "", "team_id": "", "result_status": ""}
ADMIN = "club-000-admin"
DIRECTORY = {"__user_id": ADMIN, "org_id": "club-000", "limit": 100, "offset": 0}

# Each budget name maps to the tool and parameters it measures.
QUERIES = {
    "list_my_fixtures.upcoming": ("list_my_fixtures", {**MY_FIXTURES, "mode": "upcoming"}),
    "list_my_fixtures.past": ("list_my_fixtures", {**MY_FIXTURES, "mode": "past"}),
    "list_my_fixtures.all": ("list_my_fixtures", {**MY_FIXTURES, "mode": "all"}),
    "list_club_venues": ("list_club_venues", DIRECTORY),
    "list_club_teams": ("list_club_teams", {**DIRECTORY, "division_id": None}),
}


def median_ms(db, sql, params):
    db.execute(sql, params).fetchall()  # warm-up: the first run pays for SQLite's statement cache
    timings = []
    for _ in range(RUNS):
        started = time.perf_counter()
        db.execute(sql, params).fetchall()
        timings.append((time.perf_counter() - started) * 1000)
    return statistics.median(timings)


class PerformanceBudgetTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.db = connect()
        cls.db.row_factory = sqlite3.Row
        for migration in MIGRATIONS:
            cls.db.executescript(migration["sql"])
        cls.counts = seed_association(cls.db)

    @classmethod
    def tearDownClass(cls):
        cls.db.close()

    def test_budgets_cover_every_measured_query(self):
        self.assertEqual(sorted(QUERIES), sorted(BUDGETS["query_ms"]))

    def test_seed_is_at_association_scale(self):
        # The budgets only mean something against the volumes they were set for, so a smaller seed must fail here.
        for name, minimum in BUDGETS["scale"].items():
            self.assertGreaterEqual(self.counts[name], minimum, name)

    def test_query_latency_is_within_budget(self):
        failures = []
        for name, (tool, params) in QUERIES.items():
            measured = median_ms(self.db, TOOLS[tool]["sql"], params)
            budget = BUDGETS["query_ms"][name]
            if measured > budget:
                failures.append(f"{name}: median {measured:.1f} ms exceeds the {budget} ms budget")
        self.assertEqual(failures, [])

    def test_budgets_are_documented(self):
        # A budget changed in the JSON but not in the docs would leave the docs describing the wrong limit.
        for name, budget in BUDGETS["query_ms"].items():
            self.assertIn(f"`{name}`", DOC, name)
            self.assertIn(f"{budget} ms", DOC, name)
        for name, budget in BUDGETS["bundle_gzip_kb"].items():
            self.assertIn(f"{budget} KB", DOC, name)

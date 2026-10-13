import json
import sqlite3
import unittest
from pathlib import Path

from mcp_harness import connect
from test_fixture_timing import SEED

ROOT = Path(__file__).resolve().parents[1]
MIGRATIONS = json.loads((ROOT / "migrations.json").read_text())["migrations"]
TOOLS = {tool["name"]: tool for tool in json.loads((ROOT / "mcp.json").read_text())["tools"]}

ISSUES = [
    {"source_row": 4, "severity": "blocking", "code": "conflicting_date", "field": "date", "message": "Rows give two dates", "remediation": "Correct the source"},
    {"source_row": 2, "severity": "warning", "code": "start_time_missing", "field": "start_time", "message": "No start time", "remediation": "Accept as TBC"},
    {"source_row": 2, "severity": "warning", "code": "estimated_time", "field": "time_status", "message": "Estimated time", "remediation": "Accept or confirm"},
]


class ImportRunIssueTests(unittest.TestCase):
    def setUp(self):
        self.db = connect()
        self.db.row_factory = sqlite3.Row
        for migration in MIGRATIONS:
            self.db.executescript(migration["sql"])
        self.db.executescript(SEED)
        self.run_action("record_import_run", "conv-a", id="run-9", org_id="a", kind="fixtures", received_count=3, saved_count=2, rejected_count=1,
                        status="saved", source_sha256="ab" * 32, blocking_count=1, warning_count=2, acknowledged_count=2)

    def tearDown(self):
        self.db.close()

    def run_action(self, tool, user, **params):
        return self.db.execute(TOOLS[tool]["sql"], {"__user_id": user, "__now": 1000, **params})

    def record(self, issues=ISSUES, user="conv-a", org="a", run="run-9"):
        return self.run_action("record_import_run_issues", user, org_id=org, import_run_id=run, issues=json.dumps(issues))

    def listed(self, user="conv-a", org="a", run="run-9"):
        return [dict(row) for row in self.run_action("list_import_run_issues", user, org_id=org, import_run_id=run).fetchall()]

    def test_the_stored_issue_list_round_trips_in_source_order(self):
        self.assertEqual(self.record().rowcount, 3)
        listed = self.listed()
        self.assertEqual([(row["source_row"], row["code"]) for row in listed],
                         [(2, "estimated_time"), (2, "start_time_missing"), (4, "conflicting_date")])
        blocking = listed[2]
        self.assertEqual((blocking["severity"], blocking["field"], blocking["message"], blocking["remediation"]),
                         ("blocking", "date", "Rows give two dates", "Correct the source"))
        self.assertEqual(blocking["updated_at"], 1000)

    def test_replaying_the_same_list_adds_nothing(self):
        self.record()
        self.assertEqual(self.record().rowcount, 0)
        self.assertEqual(len(self.listed()), 3)

    def test_only_managers_of_the_runs_club_can_record_or_read_issues(self):
        for user in ("play-a", "mgr-b", "outsider"):
            with self.subTest(user=user):
                self.assertEqual(self.record(user=user).rowcount, 0)
                self.assertEqual(self.listed(user=user), [])
        self.assertEqual(self.record(org="b").rowcount, 0)
        self.assertEqual(self.listed(org="b", user="mgr-b"), [])
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM import_run_issues").fetchone()[0], 0)

    def test_only_valid_issue_rows_are_stored(self):
        mixed = ISSUES + [
            {"source_row": 5, "severity": "info", "code": "fyi", "field": "", "message": "x", "remediation": ""},
            {"source_row": 0, "severity": "warning", "code": "bad_row", "field": "", "message": "x", "remediation": ""},
            {"source_row": 6, "severity": "warning", "field": "", "message": "no code", "remediation": ""},
        ]
        self.assertEqual(self.record(issues=mixed).rowcount, 3)
        self.assertEqual({row["code"] for row in self.listed()}, {"conflicting_date", "start_time_missing", "estimated_time"})

    def test_a_malformed_issue_list_stores_nothing(self):
        self.assertEqual(self.run_action("record_import_run_issues", "conv-a", org_id="a", import_run_id="run-9", issues='{"source_row": 2}').rowcount, 0)
        self.assertEqual(self.run_action("record_import_run_issues", "conv-a", org_id="a", import_run_id="run-9", issues=None).rowcount, 0)

    def test_issues_are_listed_in_pages(self):
        self.record()
        first = self.run_action("list_import_run_issues", "conv-a", org_id="a", import_run_id="run-9", limit=2, offset=0).fetchall()
        second = self.run_action("list_import_run_issues", "conv-a", org_id="a", import_run_id="run-9", limit=2, offset=2).fetchall()
        self.assertEqual(len(first), 2)
        self.assertEqual(len(second), 1)


if __name__ == "__main__":
    unittest.main()

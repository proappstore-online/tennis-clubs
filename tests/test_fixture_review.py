import json
import sqlite3
import unittest
from pathlib import Path

from mcp_harness import connect
from test_fixture_timing import SEED

ROOT = Path(__file__).resolve().parents[1]
MIGRATIONS = json.loads((ROOT / "migrations.json").read_text())["migrations"]
TOOLS = {tool["name"]: tool for tool in json.loads((ROOT / "mcp.json").read_text())["tools"]}


class FixtureReviewTests(unittest.TestCase):
    def setUp(self):
        self.db = connect()
        self.db.row_factory = sqlite3.Row
        for migration in MIGRATIONS:
            self.db.executescript(migration["sql"])
        self.db.executescript(SEED)
        self.db.execute("INSERT INTO import_runs(id,org_id,actor_user_id,kind,received_count,saved_count,rejected_count,status,created_at,blocking_count) VALUES ('run-blocked','a','conv-a','fixtures',1,1,0,'saved',1,1)")

    def tearDown(self):
        self.db.close()

    def run_action(self, tool, user, **params):
        return self.db.execute(TOOLS[tool]["sql"], {"__user_id": user, "__now": 1000, **params})

    def rows(self, tool, user, **params):
        return {item["id"]: dict(item) for item in self.run_action(tool, user, **params).fetchall()}

    def state(self, fixture_id):
        return dict(self.db.execute("SELECT review_status,reviewed_by,reviewed_at,starts_at,time_status FROM fixtures WHERE id=?", (fixture_id,)).fetchone())

    def upsert(self, fixture_id, user="conv-a", **values):
        base = {"id": fixture_id, "org_id": "a", "home_team_id": "ta", "away_team_id": "tb", "venue_id": "va",
                "starts_at": "2026-05-16T15:00:00+10:00", "round_label": fixture_id, "season": "2026", "time_status": "confirmed", "warning_codes": "[]"}
        return self.run_action("upsert_imported_fixture", user, **{**base, **values})

    def approve(self, fixture_id, user="conv-a"):
        return self.run_action("approve_fixture_review", user, fixture_id=fixture_id)

    def member_ids(self):
        return set(self.rows("list_my_fixtures", "play-a", **{"from": "2026-01-01"}))

    def test_clean_imports_are_auto_approved_and_ambiguous_ones_need_review(self):
        self.upsert("f-clean", time_status="confirmed")
        self.upsert("f-est", starts_at="2026-05-17T10:00:00+10:00", time_status="estimated")
        self.upsert("f-tbc", starts_at="2026-05-18T00:00:00+10:00", time_status="tbc")
        self.assertEqual(self.state("f-clean")["review_status"], "auto_approved")
        self.assertEqual(self.state("f-est")["review_status"], "needs_review")
        self.assertEqual(self.state("f-tbc")["review_status"], "needs_review")
        self.assertIsNone(self.state("f-tbc")["reviewed_by"])

    def test_members_see_clean_and_manual_fixtures_but_not_fixtures_awaiting_review(self):
        self.upsert("f-clean")
        self.upsert("f-tbc", starts_at="2026-05-18T00:00:00+10:00", time_status="tbc")
        visible = self.member_ids()
        self.assertIn("f-exist", visible)
        self.assertIn("f-clean", visible)
        self.assertNotIn("f-tbc", visible)

    def test_managers_see_the_review_state_of_every_imported_fixture(self):
        self.upsert("f-clean")
        self.upsert("f-tbc", starts_at="2026-05-18T00:00:00+10:00", time_status="tbc")
        managed = self.rows("list_managed_fixtures", "conv-a")
        self.assertEqual(managed["f-tbc"]["review_status"], "needs_review")
        self.assertEqual(managed["f-clean"]["review_status"], "auto_approved")
        self.assertEqual(managed["f-exist"]["review_status"], "auto_approved")

    def test_manager_approval_publishes_one_fixture_and_records_who_and_when(self):
        self.upsert("f-tbc", starts_at="2026-05-18T00:00:00+10:00", time_status="tbc")
        self.upsert("f-other", starts_at="2026-05-19T00:00:00+10:00", time_status="tbc")
        self.assertEqual(self.approve("f-tbc").rowcount, 1)
        state = self.state("f-tbc")
        self.assertEqual((state["review_status"], state["reviewed_by"], state["reviewed_at"]), ("approved", "conv-a", 1000))
        self.assertIn("f-tbc", self.member_ids())
        self.assertNotIn("f-other", self.member_ids())
        managed = self.rows("list_managed_fixtures", "conv-a")["f-tbc"]
        self.assertEqual((managed["review_status"], managed["reviewed_by_name"], managed["reviewed_at"]), ("approved", "Convenor A", 1000))

    def test_approving_twice_changes_nothing_the_second_time(self):
        self.upsert("f-tbc", starts_at="2026-05-18T00:00:00+10:00", time_status="tbc")
        self.approve("f-tbc")
        self.assertEqual(self.approve("f-tbc").rowcount, 0)
        self.assertEqual(self.state("f-tbc")["reviewed_at"], 1000)

    def test_approval_is_refused_to_non_managers_other_clubs_and_outsiders(self):
        self.upsert("f-tbc", starts_at="2026-05-18T00:00:00+10:00", time_status="tbc")
        for user in ("play-a", "mgr-b", "outsider"):
            with self.subTest(user=user):
                self.assertEqual(self.approve("f-tbc", user=user).rowcount, 0)
        self.assertEqual(self.state("f-tbc")["review_status"], "needs_review")
        self.assertNotIn("f-tbc", self.member_ids())

    def test_approval_is_refused_for_confirmed_fixtures_and_unknown_ids(self):
        self.upsert("f-clean")
        self.assertEqual(self.approve("f-clean").rowcount, 0)
        self.assertEqual(self.approve("f-exist").rowcount, 0)
        self.assertEqual(self.approve("no-such-fixture").rowcount, 0)
        self.assertIsNone(self.state("f-clean")["reviewed_by"])

    def test_a_blocking_conflict_in_the_fixtures_import_refuses_approval(self):
        self.upsert("f-blocked", starts_at="2026-05-18T00:00:00+10:00", time_status="tbc", import_run_id="run-blocked")
        self.assertEqual(self.state("f-blocked")["review_status"], "needs_review")
        self.assertEqual(self.approve("f-blocked").rowcount, 0)
        self.assertNotIn("f-blocked", self.member_ids())

    def test_unchanged_reimport_keeps_a_manager_approval(self):
        self.upsert("f-est", starts_at="2026-05-17T10:00:00+10:00", time_status="estimated")
        self.approve("f-est")
        self.upsert("f-est", starts_at="2026-05-17T10:00:00+10:00", time_status="estimated")
        state = self.state("f-est")
        self.assertEqual((state["review_status"], state["reviewed_by"]), ("approved", "conv-a"))

    def test_a_later_confirmed_time_auto_approves_and_clears_the_old_approval(self):
        self.upsert("f-est", starts_at="2026-05-17T10:00:00+10:00", time_status="estimated")
        self.approve("f-est")
        self.upsert("f-est", starts_at="2026-05-17T10:00:00+10:00", time_status="confirmed")
        state = self.state("f-est")
        self.assertEqual((state["review_status"], state["reviewed_by"], state["reviewed_at"]), ("auto_approved", None, None))

    def test_moving_an_approved_time_needs_review_again(self):
        self.upsert("f-est", starts_at="2026-05-17T10:00:00+10:00", time_status="estimated")
        self.approve("f-est")
        moved = self.run_action("reconcile_imported_fixture_time", "conv-a", org_id="a", round_label="f-est", home_team_id="ta", away_team_id="tb",
                                starts_at="2026-05-17T11:00:00+10:00", time_status="estimated", source_row=3, import_run_id="run-2")
        self.assertEqual(moved.rowcount, 1)
        state = self.state("f-est")
        self.assertEqual((state["review_status"], state["reviewed_by"]), ("needs_review", None))
        self.assertNotIn("f-est", self.member_ids())

    def test_rows_imported_before_this_migration_are_classified_from_their_time(self):
        self.db.execute("INSERT INTO fixtures(id,org_id,division_id,home_team_id,away_team_id,venue_id,starts_at,round_label,status,created_at,time_status,source_import_run_id) VALUES ('legacy-tbc','a','da','ta','tb','va','2026-06-01T00:00:00+10:00','L1','scheduled',1,'tbc','old-run')")
        self.db.execute("INSERT INTO fixtures(id,org_id,division_id,home_team_id,away_team_id,venue_id,starts_at,round_label,status,created_at,time_status,source_import_run_id) VALUES ('legacy-ok','a','da','ta','tb','va','2026-06-02T15:00:00+10:00','L2','scheduled',1,'confirmed','old-run')")
        self.db.execute("INSERT INTO fixtures(id,org_id,division_id,home_team_id,away_team_id,venue_id,starts_at,round_label,status,created_at,time_status) VALUES ('manual','a','da','ta','tb','va','2026-06-03T15:00:00+10:00','M1','scheduled',1,'estimated')")
        visible = self.member_ids()
        self.assertNotIn("legacy-tbc", visible)
        self.assertIn("legacy-ok", visible)
        self.assertIn("manual", visible)
        self.assertEqual(self.rows("list_managed_fixtures", "conv-a")["legacy-tbc"]["review_status"], "needs_review")
        self.assertEqual(self.approve("legacy-tbc").rowcount, 1)
        self.assertIn("legacy-tbc", self.member_ids())

    def test_the_approval_audit_entry_records_the_approver_and_time(self):
        self.upsert("f-tbc", starts_at="2026-05-18T00:00:00+10:00", time_status="tbc")
        self.approve("f-tbc")
        self.assertEqual(self.run_action("record_audit_event", "conv-a", id="aud-approve", org_id="a", action="approve_fixture_review", target_type="fixture", target_id="f-tbc", outcome="succeeded").rowcount, 1)
        audit = dict(self.db.execute("SELECT actor_user_id,action,target_id,outcome,created_at FROM audit_events WHERE id='aud-approve'").fetchone())
        self.assertEqual(audit, {"actor_user_id": "conv-a", "action": "approve_fixture_review", "target_id": "f-tbc", "outcome": "succeeded", "created_at": 1000})
        self.assertEqual(self.run_action("record_audit_event", "play-a", id="aud-x", org_id="a", action="approve_fixture_review", target_type="fixture", target_id="f-tbc", outcome="succeeded").rowcount, 0)


if __name__ == "__main__":
    unittest.main()

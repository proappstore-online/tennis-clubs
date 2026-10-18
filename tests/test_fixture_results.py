import json
import sqlite3
import unittest
from pathlib import Path

from mcp_harness import connect

ROOT = Path(__file__).resolve().parents[1]
MIGRATIONS = json.loads((ROOT / "migrations.json").read_text())["migrations"]
TOOLS = {tool["name"]: tool for tool in json.loads((ROOT / "mcp.json").read_text())["tools"]}


class FixtureResultTests(unittest.TestCase):
    def setUp(self):
        self.db = connect()
        self.db.row_factory = sqlite3.Row
        for migration in MIGRATIONS:
            self.db.executescript(migration["sql"])
        self.db.execute("INSERT INTO organizations(id,name,slug,logo_url,created_at,created_by) VALUES('club','Club','club',NULL,1,NULL)")
        self.db.executemany("INSERT INTO club_memberships(id,org_id,user_id,role,display_name,is_active,created_at) VALUES(?,?,?,?,?,1,1)", [
            ("mgr", "club", "manager", "manager", "Manager"), ("player", "club", "player", "player", "Player")])
        self.db.executemany("INSERT INTO teams(id,org_id,name,created_at) VALUES(?,?,?,1)", [("home", "club", "Home"), ("away", "club", "Away")])
        self.db.execute("INSERT INTO fixtures(id,org_id,home_team_id,away_team_id,starts_at,created_at) VALUES('f','club','home','away','2026-10-11T09:00:00+11:00',1)")

    def tearDown(self): self.db.close()

    def submit(self, id, user="manager", home=3, away=2, path="card.pdf", note=""):
        params = {"id": id, "__user_id": user, "__now": 1791670000000 + (1 if id == "two" else 0), "fixture_id": "f", "home_score": home, "away_score": away, "set_results": '[{"home":6,"away":4}]', "scorecard_user_id": user if path else None, "scorecard_path": path, "correction_note": note}
        result = self.db.execute(TOOLS["submit_fixture_result"]["sql"], params)
        if result.rowcount:
            self.db.execute(TOOLS["apply_fixture_result_to_fixture"]["sql"], {"__user_id": user, "__now": params["__now"], "submission_id": id, "fixture_id": "f"})
        return result

    def test_manager_result_updates_fixture_and_retains_corrections(self):
        self.assertTrue(TOOLS["submit_fixture_result"]["requires_auth"])
        self.assertTrue(TOOLS["apply_fixture_result_to_fixture"]["requires_auth"])
        self.submit("one")
        self.submit("two", home=2, away=3, note="Corrected after card review")
        self.assertEqual(tuple(self.db.execute("SELECT home_score,away_score,status FROM fixtures WHERE id='f'").fetchone()), (2, 3, "complete"))
        history = self.db.execute(TOOLS["list_fixture_result_history"]["sql"], {"fixture_id": "f", "__user_id": "manager"}).fetchall()
        self.assertEqual(len(history), 2)
        self.assertEqual(history[0]["correction_note"], "Corrected after card review")
        self.assertEqual(history[1]["home_score"], 3)

    def test_member_fixture_list_shows_completed_scores_for_recent_results_only(self):
        self.db.execute("INSERT INTO team_memberships(id,org_id,team_id,user_id,created_by,accepted_at,created_at) VALUES('m','club','home','player','manager',1,1)")
        self.db.executemany("INSERT INTO fixtures(id,org_id,home_team_id,away_team_id,starts_at,status,created_at) VALUES(?,?,?,?,?,?,1)", [
            ("next", "club", "home", "away", "2026-10-25T09:00:00+11:00", "scheduled"),
            ("stale", "club", "home", "away", "2026-09-10T09:00:00+10:00", "complete"),
            ("open-past", "club", "home", "away", "2026-10-12T09:00:00+11:00", "scheduled")])
        self.db.execute("UPDATE fixtures SET home_score=3,away_score=5,status='complete' WHERE id='f'")
        self.db.execute("UPDATE fixtures SET home_score=1,away_score=0,status='complete' WHERE id='stale'")
        rows = self.db.execute(TOOLS["list_my_fixtures"]["sql"], {"__user_id": "player", "from": "2026-10-18T00:00:00+11:00", "limit": 50}).fetchall()
        self.assertEqual([row["id"] for row in rows], ["next", "f"])
        self.assertEqual((rows[1]["home_score"], rows[1]["away_score"], rows[1]["status"]), (3, 5, "complete"))
        self.assertIsNone(rows[0]["home_score"])
        self.assertNotIn("scorecard_path", rows[1].keys())
        self.assertNotIn("set_results", rows[1].keys())

    def test_non_manager_cannot_submit_or_read_results(self):
        self.submit("denied", user="player")
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM fixture_result_submissions").fetchone()[0], 0)
        self.assertEqual(self.db.execute(TOOLS["list_managed_fixture_results"]["sql"], {"__user_id": "player"}).fetchall(), [])

    def test_managers_see_missing_card_and_submitted_private_reference(self):
        q = TOOLS["list_managed_fixture_results"]["sql"]
        self.assertEqual(self.db.execute(q, {"__user_id": "manager"}).fetchone()["card_state"], "missing")
        self.submit("one")
        row = self.db.execute(q, {"__user_id": "manager"}).fetchone()
        self.assertEqual(row["card_state"], "submitted")
        self.assertEqual(row["scorecard_path"], "card.pdf")
        self.assertNotIn("publicUrl", (ROOT / "web/src/pages/RosterAdmin.tsx").read_text())

    def test_manager_query_flags_late_missing_and_incomplete_cards(self):
        q = TOOLS["list_managed_fixture_results"]["sql"]
        self.db.execute("UPDATE fixtures SET starts_at='2026-09-01T09:00:00+10:00',status='complete' WHERE id='f'")
        self.assertEqual(self.db.execute(q, {"__user_id": "manager"}).fetchone()["card_state"], "late")
        self.submit("no-card", path=None)
        self.assertEqual(self.db.execute(q, {"__user_id": "manager"}).fetchone()["card_state"], "incomplete")

    def test_manager_result_reads_exclude_fixtures_with_foreign_club_teams(self):
        self.db.execute("INSERT INTO organizations(id,name,slug,created_at) VALUES('other','Other','other',1)")
        self.db.executemany("INSERT INTO teams(id,org_id,name,created_at) VALUES(?,?,?,1)", [
            ("foreign-home", "other", "Private home"), ("foreign-away", "other", "Private away")])
        # Simulate a legacy/imported fixture that bypassed current write validation.
        self.db.execute("INSERT INTO fixtures(id,org_id,home_team_id,away_team_id,starts_at,created_at) VALUES('bad','club','foreign-home','foreign-away','2026-10-12T09:00:00+11:00',1)")
        self.db.execute("INSERT INTO fixture_result_submissions(id,fixture_id,submitted_by,home_score,away_score,submitted_at,scorecard_path) VALUES('private','bad','manager',6,0,2,'private-scorecard.pdf')")
        # An external opponent is a placeholder team owned by this club, so its fixture stays visible.
        self.db.execute("INSERT INTO external_clubs(id,org_id,canonical_name,normalized_name,created_at) VALUES('rival','club','Rival Club','rival club',1)")
        self.db.execute("INSERT INTO teams(id,org_id,name,created_at,external_club_id,is_external) VALUES('rival-placeholder','club','Rival Club',1,'rival',1)")
        self.db.execute("INSERT INTO fixtures(id,org_id,home_team_id,away_team_id,starts_at,created_at) VALUES('ext','club','home','rival-placeholder','2026-10-13T09:00:00+11:00',1)")
        params = {"__user_id": "manager"}
        self.assertEqual(sorted(row["fixture_id"] for row in self.db.execute(TOOLS["list_managed_fixture_results"]["sql"], params)), ["ext", "f"])
        history = self.db.execute(TOOLS["list_fixture_result_history"]["sql"], {**params, "fixture_id": "bad"}).fetchall()
        self.assertEqual(history, [])


if __name__ == "__main__": unittest.main()

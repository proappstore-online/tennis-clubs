import json
import sqlite3
import unittest
from pathlib import Path

from mcp_harness import connect

ROOT = Path(__file__).resolve().parents[1]
MIGRATIONS = json.loads((ROOT / "migrations.json").read_text())["migrations"]
TOOLS = {tool["name"]: tool for tool in json.loads((ROOT / "mcp.json").read_text())["tools"]}
FIXTURE = "fixture-hawthorn-gsd1-2026-10-18"


class Round2ResultTests(unittest.TestCase):
    def setUp(self):
        self.db = connect()
        self.db.row_factory = sqlite3.Row
        for migration in MIGRATIONS:
            self.db.executescript(migration["sql"])
        self.db.execute("INSERT INTO organizations(id,name,slug,logo_url,created_at,created_by) VALUES('hawthorn','Hawthorn Tennis Club','hawthorn',NULL,1,NULL)")
        self.db.executemany("INSERT INTO club_memberships(id,org_id,user_id,role,display_name,is_active,created_at) VALUES(?,?,?,?,?,1,1)", [
            ("mgr", "hawthorn", "manager", "manager", "Manager"), ("player", "hawthorn", "player", "player", "Player")])
        self.db.execute("INSERT INTO teams(id,org_id,name,created_at) VALUES('hawthorn-gsd1','hawthorn','Hawthorn',1)")
        # Blackburn is an external opponent: a placeholder team owned by this club.
        self.db.execute("INSERT INTO external_clubs(id,org_id,canonical_name,normalized_name,created_at) VALUES('blackburn','hawthorn','Blackburn','blackburn',1)")
        self.db.execute("INSERT INTO teams(id,org_id,name,created_at,external_club_id,is_external) VALUES('blackburn-placeholder','hawthorn','Blackburn',1,'blackburn',1)")
        self.db.execute("INSERT INTO fixtures(id,org_id,round_label,home_team_id,away_team_id,starts_at,status,created_at) VALUES(?,'hawthorn','Round 2','blackburn-placeholder','hawthorn-gsd1','2026-10-18T10:00:00+11:00','scheduled',1)", (FIXTURE,))

    def tearDown(self): self.db.close()

    def record(self, user="manager", home=3, away=5, submission="round2-1"):
        # Game totals (21 / 35) have no column of their own; set_results is a per-set JSON array and no set breakdown is known, so it is left empty.
        params = {"id": submission, "__user_id": user, "__now": 1792300000000, "fixture_id": FIXTURE, "home_score": home, "away_score": away, "set_results": "", "scorecard_user_id": user, "scorecard_path": "scorecards/round2.pdf", "correction_note": ""}
        result = self.db.execute(TOOLS["submit_fixture_result"]["sql"], params)
        if result.rowcount:
            self.db.execute(TOOLS["apply_fixture_result_to_fixture"]["sql"], {"__user_id": user, "__now": params["__now"], "submission_id": submission, "fixture_id": FIXTURE})
        return result

    def test_manager_records_round2_result_and_fixture_is_marked_complete(self):
        self.assertEqual(self.record().rowcount, 1)
        fixture = self.db.execute("SELECT home_score,away_score,status FROM fixtures WHERE id=?", (FIXTURE,)).fetchone()
        self.assertEqual((fixture["home_score"], fixture["away_score"], fixture["status"]), (3, 5, "complete"))
        history = self.db.execute(TOOLS["list_fixture_result_history"]["sql"], {"fixture_id": FIXTURE, "__user_id": "manager"}).fetchall()
        self.assertEqual(len(history), 1)
        self.assertEqual((history[0]["home_score"], history[0]["away_score"], history[0]["submitted_by"]), (3, 5, "manager"))

    def test_member_cannot_record_round2_result(self):
        self.assertEqual(self.record(user="player").rowcount, 0)
        fixture = self.db.execute("SELECT home_score,away_score,status FROM fixtures WHERE id=?", (FIXTURE,)).fetchone()
        self.assertEqual((fixture["home_score"], fixture["away_score"], fixture["status"]), (None, None, "scheduled"))
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM fixture_result_submissions").fetchone()[0], 0)


if __name__ == "__main__":
    unittest.main()

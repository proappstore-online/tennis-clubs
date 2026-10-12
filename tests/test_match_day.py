import json
import sqlite3
import unittest
from pathlib import Path

from mcp_harness import connect

ROOT = Path(__file__).resolve().parents[1]
MIGRATIONS = json.loads((ROOT / "migrations.json").read_text())["migrations"]
TOOLS = {tool["name"]: tool for tool in json.loads((ROOT / "mcp.json").read_text())["tools"]}


class MatchDayTests(unittest.TestCase):
    def setUp(self):
        self.db = connect()
        self.db.row_factory = sqlite3.Row
        self.db.execute("PRAGMA foreign_keys=ON")
        for migration in MIGRATIONS:
            self.db.executescript(migration["sql"])
        self.db.execute("INSERT INTO organizations(id,name,slug,created_at) VALUES('club','Club','club',1)")
        self.db.executemany("INSERT INTO club_memberships(id,org_id,user_id,role,display_name,is_active,created_at) VALUES(?,?,?,?,?,1,1)", [
            ("admin", "club", "admin-user", "admin", "Admin"),
            ("manager", "club", "manager-user", "manager", "Manager"),
            ("player", "club", "player-user", "player", "Player"),
        ])
        self.db.executemany("INSERT INTO teams(id,org_id,name,created_at) VALUES(?,?,?,1)", [("home", "club", "Home"), ("away", "club", "Away")])
        self.db.execute("INSERT INTO fixtures(id,org_id,home_team_id,away_team_id,starts_at,home_score,away_score,created_at) VALUES('fixture','club','home','away','2026-10-11T09:00:00+11:00',3,2,1)")

    def tearDown(self):
        self.db.close()

    def update(self, user, status, notice=""):
        return self.db.execute(TOOLS["update_fixture_match_day"]["sql"], {"__user_id": user, "__now": 123456, "fixture_id": "fixture", "status": status, "match_notice": notice})

    def test_status_update_is_auth_only_valid_and_preserves_scores(self):
        self.assertTrue(TOOLS["update_fixture_match_day"]["requires_auth"])
        for status in ("scheduled", "washout", "heat_out", "forfeit", "complete"):
            self.update("manager-user", status, "Play stopped after set one")
            row = self.db.execute("SELECT status,status_updated_at,match_notice,home_score,away_score FROM fixtures WHERE id='fixture'").fetchone()
            self.assertEqual(tuple(row), (status, 123456, "Play stopped after set one", 3, 2))
        self.update("player-user", "washout", "unauthorised")
        row = self.db.execute("SELECT status,match_notice FROM fixtures WHERE id='fixture'").fetchone()
        self.assertEqual(tuple(row), ("complete", "Play stopped after set one"))
        self.update("manager-user", "disciplinary_penalty", "")
        self.assertEqual(self.db.execute("SELECT status FROM fixtures WHERE id='fixture'").fetchone()[0], "complete")

    def test_admin_can_update_but_other_club_roles_cannot_and_notice_is_bounded(self):
        self.update("admin-user", "heat_out", "")
        row = self.db.execute("SELECT status,status_updated_at,match_notice FROM fixtures WHERE id='fixture'").fetchone()
        self.assertEqual(tuple(row), ("heat_out", 123456, None))
        self.db.execute(TOOLS["update_fixture_match_day"]["sql"], {"__user_id": "manager-user", "__now": 9, "fixture_id": "fixture", "status": "complete", "match_notice": "x" * 281})
        self.assertEqual(self.db.execute("SELECT status FROM fixtures WHERE id='fixture'").fetchone()[0], "heat_out")


if __name__ == "__main__":
    unittest.main()

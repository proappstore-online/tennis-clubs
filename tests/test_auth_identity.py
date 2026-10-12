import json
import sqlite3
import unittest
from pathlib import Path

from mcp_harness import connect


ROOT = Path(__file__).resolve().parents[1]
MIGRATIONS = json.loads((ROOT / "migrations.json").read_text())["migrations"]
TOOLS = {tool["name"]: tool for tool in json.loads((ROOT / "mcp.json").read_text())["tools"]}


class AuthIdentityTests(unittest.TestCase):
    def setUp(self):
        self.db = connect()
        self.db.row_factory = sqlite3.Row
        for migration in MIGRATIONS:
            self.db.executescript(migration["sql"])
        self.db.executescript("""
          INSERT INTO organizations(id,name,slug,created_at) VALUES
            ('club-a','Club A','club-a',1),('club-b','Club B','club-b',1);
          INSERT INTO club_memberships(id,org_id,user_id,role,display_name,is_active,created_at) VALUES
            ('admin-a','club-a','pas-admin','admin','Admin A',1,1),
            ('player-a','club-a','pas-player','player','Player A',1,1),
            ('manager-b','club-b','other-manager','manager','Manager B',1,1);
          INSERT INTO seasons(id,org_id,name,starts_on,ends_on,created_at) VALUES
            ('season-a','club-a','Season','2026-01-01','2026-12-31',1);
          INSERT INTO divisions(id,season_id,name,created_at) VALUES ('division-a','season-a','A',1);
          INSERT INTO teams(id,org_id,division_id,name,created_at) VALUES
            ('team-a','club-a','division-a','A',1),('team-b','club-b',NULL,'B',1);
          INSERT INTO fixtures(id,org_id,home_team_id,away_team_id,starts_at,created_at) VALUES
            ('fixture-a','club-a','team-a','team-a','2026-11-01T09:00:00+11:00',1);
          INSERT INTO team_memberships(id,org_id,team_id,user_id,display_name,invite_token,created_by,accepted_at,created_at) VALUES
            ('accepted','club-a','team-a','pas-player','Player A',NULL,'pas-admin',1,1),
            ('pending','club-a','team-a',NULL,'Invited','pending-secret','pas-admin',NULL,1);
        """)

    def tearDown(self):
        self.db.close()

    def test_user_scoped_and_role_sensitive_actions_require_platform_auth(self):
        protected = {
            "list_my_fixtures", "list_fixture_roster", "set_my_fixture_availability",
            "list_managed_clubs", "create_club", "bootstrap_club_admin",
            "create_season", "create_division", "create_venue", "create_team",
            "create_team_invite", "accept_team_invite",
        }
        for name in protected:
            with self.subTest(action=name):
                self.assertTrue(TOOLS[name]["requires_auth"])

    def test_platform_identity_maps_to_only_its_club_role_and_accepted_team(self):
        memberships = self.db.execute(
            "SELECT org_id,role FROM club_memberships WHERE user_id=? AND is_active=1",
            ("pas-admin",),
        ).fetchall()
        self.assertEqual([(row["org_id"], row["role"]) for row in memberships], [("club-a", "admin")])

        fixtures = self.db.execute(TOOLS["list_my_fixtures"]["sql"], {
            "__user_id": "pas-player", "from": "2026-10-01", "limit": 50,
        }).fetchall()
        self.assertEqual([row["id"] for row in fixtures], ["fixture-a"])
        self.assertEqual(self.db.execute(TOOLS["list_my_fixtures"]["sql"], {
            "__user_id": "other-manager", "from": "2026-10-01", "limit": 50,
        }).fetchall(), [])

    def test_pending_team_invite_does_not_grant_fixture_or_availability_access(self):
        fixtures = self.db.execute(TOOLS["list_my_fixtures"]["sql"], {
            "__user_id": "invitee", "from": "2026-10-01", "limit": 50,
        }).fetchall()
        self.assertEqual(fixtures, [])
        changed = self.db.execute(TOOLS["set_my_fixture_availability"]["sql"], {
            "__user_id": "invitee", "__now": 10,
            "fixture_id": "fixture-a", "availability": "in",
        })
        self.assertEqual(changed.rowcount, 0)

    def test_admin_writes_are_club_scoped_at_the_action_layer(self):
        sql = TOOLS["create_season"]["sql"]
        values = {
            "id": "season-bad", "org_id": "club-a", "name": "Season",
            "starts_on": "2026-01-01", "ends_on": "2026-12-31", "status": "upcoming",
        }
        denied = self.db.execute(sql, {"__user_id": "other-manager", "__now": 10, **values})
        self.assertEqual(denied.rowcount, 0)
        allowed = self.db.execute(sql, {"__user_id": "pas-admin", "__now": 10, **values})
        self.assertEqual(allowed.rowcount, 1)


if __name__ == "__main__":
    unittest.main()

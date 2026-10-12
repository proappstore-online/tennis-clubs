import json
import sqlite3
import unittest
from pathlib import Path

from mcp_harness import connect

ROOT = Path(__file__).resolve().parents[1]
MIGRATIONS = json.loads((ROOT / "migrations.json").read_text())["migrations"]
TOOLS = {tool["name"]: tool for tool in json.loads((ROOT / "mcp.json").read_text())["tools"]}


class RoleMatrixTests(unittest.TestCase):
    def setUp(self):
        self.db = connect()
        self.db.row_factory = sqlite3.Row
        self.db.execute("PRAGMA foreign_keys=ON")
        for migration in MIGRATIONS:
            self.db.executescript(migration["sql"])
        self.db.executemany("INSERT INTO organizations(id,name,slug,created_at) VALUES(?,?,?,1)", [("club-a", "Club A", "club-a"), ("club-b", "Club B", "club-b")])
        self.db.executemany(
            "INSERT INTO club_memberships(id,org_id,user_id,role,display_name,is_active,created_at) VALUES(?,?,?,?,?,?,1)",
            [
                ("admin-a", "club-a", "admin-user", "admin", "Admin", 1),
                ("convenor-a", "club-a", "convenor-user", "convenor", "Convenor", 1),
                ("manager-a", "club-a", "manager-user", "manager", "Manager", 1),
                ("player-a", "club-a", "player-user", "player", "Player", 1),
                ("parent-a", "club-a", "parent-user", "parent", "Parent", 1),
                ("inactive-a", "club-a", "inactive-user", "manager", "Inactive", 0),
                ("dual-a", "club-a", "dual-user", "admin", "Dual", 1),
                ("dual-b", "club-b", "dual-user", "player", "Dual", 1),
                ("convenor-b", "club-b", "convenor-b-user", "convenor", "Convenor B", 1),
                ("manager-b", "club-b", "manager-b-user", "manager", "Manager B", 1),
            ],
        )
        self.db.executemany("INSERT INTO seasons(id,org_id,name,starts_on,ends_on,created_at) VALUES(?,?,'Season','2026-01-01','2026-12-31',1)", [("season-a", "club-a"), ("season-b", "club-b")])
        self.db.executemany("INSERT INTO divisions(id,season_id,name,created_at) VALUES(?,?,'Division',1)", [("division-a", "season-a"), ("division-b", "season-b")])
        self.db.executemany("INSERT INTO teams(id,org_id,division_id,name,created_at) VALUES(?,?,?,?,1)", [
            ("team-a", "club-a", "division-a", "Team A"), ("team-a2", "club-a", "division-a", "Team A2"),
            ("team-b", "club-b", "division-b", "Team B"), ("team-b2", "club-b", "division-b", "Team B2"),
        ])
        self.db.executemany("INSERT INTO fixtures(id,org_id,division_id,home_team_id,away_team_id,starts_at,created_at) VALUES(?,?,?,?,?,'2026-10-11T09:00:00+11:00',1)", [
            ("fixture-a", "club-a", "division-a", "team-a", "team-a2"),
            ("fixture-b", "club-b", "division-b", "team-b", "team-b2"),
        ])
        self.db.executemany("INSERT INTO team_memberships(id,org_id,team_id,user_id,display_name,created_by,accepted_at,created_at) VALUES(?,?,?,?,?,'manager-user',1,1)", [
            ("tm-player-a", "club-a", "team-a", "player-user", "Player"),
            ("tm-dual-b", "club-b", "team-b", "dual-user", "Dual"),
        ])
        self.db.commit()

    def tearDown(self):
        self.db.close()

    def run_action(self, tool, user, **values):
        return self.db.execute(TOOLS[tool]["sql"], {"__user_id": user, "__now": 10, **values})

    def can_create_season(self, user, org):
        before = self.db.execute("SELECT COUNT(*) FROM seasons").fetchone()[0]
        self.run_action("create_season", user, id=f"season-{user}-{org}-{before}", org_id=org, name="New", starts_on="2026-01-01", ends_on="2026-12-31", status="upcoming")
        return self.db.execute("SELECT COUNT(*) FROM seasons").fetchone()[0] > before

    def test_every_club_role_gate_treats_convenor_as_manager(self):
        for name, tool in TOOLS.items():
            sql = tool.get("sql", "")
            if tool["contract"]["roles"] == ["admin"]:
                continue
            if "cm.role IN (" in sql or "role IN (" in sql:
                with self.subTest(action=name):
                    self.assertIn("'convenor'", sql)
                    self.assertIn("'manager'", sql)

    def test_convenor_performs_manager_operations_in_own_club(self):
        self.assertTrue(self.can_create_season("convenor-user", "club-a"))
        self.assertEqual(self.run_action("create_venue", "convenor-user", id="venue-a", org_id="club-a", name="Courts", address="", map_url="", notes="", convenor_phone="").rowcount, 1)
        self.assertEqual(self.run_action("create_team_invite", "convenor-user", id="invite-a", team_id="team-a", invite_token="convenor-token").rowcount, 1)
        self.assertEqual(self.run_action("add_fixture_roster_player", "convenor-user", fixture_id="fixture-a", user_id="player-user").rowcount, 1)
        self.assertEqual(self.run_action("update_fixture_match_day", "convenor-user", fixture_id="fixture-a", status="washout", match_notice="Rain").rowcount, 1)
        self.assertEqual(self.run_action("submit_fixture_result", "convenor-user", id="result-a", fixture_id="fixture-a", home_score=3, away_score=1, set_results="", scorecard_user_id=None, scorecard_path=None, correction_note="").rowcount, 1)
        self.assertEqual([row["id"] for row in self.db.execute(TOOLS["list_managed_clubs"]["sql"], {"__user_id": "convenor-user"}).fetchall()], ["club-a"])
        self.assertEqual(len(self.db.execute(TOOLS["list_club_members"]["sql"], {"__user_id": "convenor-user", "org_id": "club-a"}).fetchall()), 6)

    def test_inactive_membership_is_denied_admin_and_manager_operations(self):
        self.assertFalse(self.can_create_season("inactive-user", "club-a"))
        self.assertEqual(self.run_action("add_fixture_roster_player", "inactive-user", fixture_id="fixture-a", user_id="player-user").rowcount, 0)
        self.assertEqual(self.db.execute(TOOLS["list_managed_clubs"]["sql"], {"__user_id": "inactive-user"}).fetchall(), [])
        self.assertEqual(self.db.execute(TOOLS["get_my_club_permissions"]["sql"], {"__user_id": "inactive-user", "org_id": "club-a"}).fetchone()["can_manage"], 0)

    def test_cross_club_roles_cannot_manage_another_club(self):
        self.assertFalse(self.can_create_season("convenor-user", "club-b"))
        self.assertFalse(self.can_create_season("admin-user", "club-b"))
        self.assertEqual(self.run_action("create_venue", "convenor-user", id="cross-venue", org_id="club-b", name="Other", address="", map_url="", notes="", convenor_phone="").rowcount, 0)
        self.assertEqual(self.run_action("add_fixture_roster_player", "convenor-user", fixture_id="fixture-b", user_id="dual-user").rowcount, 0)
        self.assertEqual(self.run_action("update_fixture_match_day", "manager-user", fixture_id="fixture-b", status="washout", match_notice="").rowcount, 0)
        self.assertEqual(self.db.execute(TOOLS["list_club_venues"]["sql"], {"__user_id": "convenor-user", "org_id": "club-b"}).fetchall(), [])
        self.assertEqual(self.db.execute(TOOLS["list_club_members"]["sql"], {"__user_id": "convenor-b-user", "org_id": "club-a"}).fetchall(), [])

    def test_parent_cannot_perform_manager_or_admin_operations(self):
        self.assertFalse(self.can_create_season("parent-user", "club-a"))
        self.assertEqual(self.run_action("create_team_invite", "parent-user", id="parent-invite", team_id="team-a", invite_token="parent-token").rowcount, 0)
        self.assertEqual(self.run_action("update_fixture_match_day", "parent-user", fixture_id="fixture-a", status="washout", match_notice="").rowcount, 0)
        self.assertEqual(self.run_action("submit_fixture_result", "parent-user", id="parent-result", fixture_id="fixture-a", home_score=1, away_score=0, set_results="", scorecard_user_id=None, scorecard_path=None, correction_note="").rowcount, 0)
        self.assertEqual(self.db.execute(TOOLS["list_managed_fixtures"]["sql"], {"__user_id": "parent-user"}).fetchall(), [])
        self.assertEqual(self.db.execute(TOOLS["list_fixture_import_options"]["sql"], {"__user_id": "parent-user"}).fetchall(), [])

    def test_player_cannot_perform_manager_or_admin_operations_but_reads_own_fixtures(self):
        self.assertFalse(self.can_create_season("player-user", "club-a"))
        self.assertEqual(self.run_action("add_fixture_roster_player", "player-user", fixture_id="fixture-a", user_id="player-user").rowcount, 0)
        self.assertEqual(self.run_action("update_fixture_match_day", "player-user", fixture_id="fixture-a", status="washout", match_notice="").rowcount, 0)
        self.assertEqual(self.db.execute(TOOLS["list_club_members"]["sql"], {"__user_id": "player-user", "org_id": "club-a"}).fetchall(), [])
        self.assertEqual(self.db.execute(TOOLS["get_my_club_permissions"]["sql"], {"__user_id": "player-user", "org_id": "club-a"}).fetchone()["can_manage"], 0)
        fixtures = self.db.execute(TOOLS["list_my_fixtures"]["sql"], {"__user_id": "player-user", "from": "2026-01-01", "limit": 50}).fetchall()
        self.assertEqual([row["id"] for row in fixtures], ["fixture-a"])

    def test_same_user_holds_different_roles_per_club(self):
        self.assertTrue(self.can_create_season("dual-user", "club-a"))
        self.assertFalse(self.can_create_season("dual-user", "club-b"))
        managed = [row["id"] for row in self.db.execute(TOOLS["list_managed_clubs"]["sql"], {"__user_id": "dual-user"}).fetchall()]
        self.assertEqual(managed, ["club-a"])
        permissions = {row["org_id"]: (row["role"], row["can_manage"]) for row in [
            self.db.execute(TOOLS["get_my_club_permissions"]["sql"], {"__user_id": "dual-user", "org_id": org}).fetchone() for org in ("club-a", "club-b")]}
        self.assertEqual(permissions, {"club-a": ("admin", 1), "club-b": ("player", 0)})
        fixtures = self.db.execute(TOOLS["list_my_fixtures"]["sql"], {"__user_id": "dual-user", "from": "2026-01-01", "limit": 50}).fetchall()
        self.assertEqual([row["id"] for row in fixtures], ["fixture-b"])

    def test_get_my_club_permissions_returns_nothing_for_non_members(self):
        self.assertEqual(self.db.execute(TOOLS["get_my_club_permissions"]["sql"], {"__user_id": "outsider", "org_id": "club-a"}).fetchall(), [])

    def test_invite_activation_creates_active_player_membership_for_team_club(self):
        self.run_action("create_team_invite", "manager-user", id="invite-new", team_id="team-a", invite_token="new-token")
        self.run_action("activate_invited_club_membership", "new-user", id="cm-new", claim_token="new-token", display_name="New Player")
        row = self.db.execute("SELECT org_id,role,is_active FROM club_memberships WHERE user_id='new-user'").fetchone()
        self.assertEqual(tuple(row), ("club-a", "player", 1))
        self.run_action("accept_team_invite", "new-user", claim_token="new-token", display_name="New Player")
        self.assertEqual(self.db.execute("SELECT user_id FROM team_memberships WHERE invite_token IS NULL AND team_id='team-a' AND user_id='new-user'").fetchone()[0], "new-user")

    def test_invite_activation_keeps_existing_club_role_and_is_retry_safe(self):
        self.run_action("create_team_invite", "manager-user", id="invite-admin", team_id="team-a", invite_token="admin-token")
        self.run_action("activate_invited_club_membership", "admin-user", id="cm-dup", claim_token="admin-token", display_name="Admin")
        self.run_action("activate_invited_club_membership", "admin-user", id="cm-dup-2", claim_token="admin-token", display_name="Admin")
        rows = self.db.execute("SELECT role,is_active FROM club_memberships WHERE user_id='admin-user' AND org_id='club-a'").fetchall()
        self.assertEqual([tuple(row) for row in rows], [("admin", 1)])

    def test_invite_activation_does_not_reactivate_inactive_member(self):
        self.run_action("create_team_invite", "manager-user", id="invite-inactive", team_id="team-a", invite_token="inactive-token")
        self.run_action("activate_invited_club_membership", "inactive-user", id="cm-inactive", claim_token="inactive-token", display_name="Inactive")
        row = self.db.execute("SELECT role,is_active FROM club_memberships WHERE user_id='inactive-user'").fetchone()
        self.assertEqual(tuple(row), ("manager", 0))

    def test_accept_team_invite_requires_no_pas_app_role(self):
        self.assertNotIn("auth", TOOLS["accept_team_invite"])


if __name__ == "__main__":
    unittest.main()

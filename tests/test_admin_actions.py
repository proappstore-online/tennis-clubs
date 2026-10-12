import json
import sqlite3
import unittest
from pathlib import Path

from mcp_harness import connect

ROOT = Path(__file__).resolve().parents[1]
MIGRATIONS = json.loads((ROOT / "migrations.json").read_text())["migrations"]
TOOLS = {tool["name"]: tool for tool in json.loads((ROOT / "mcp.json").read_text())["tools"]}


class AdminActionTests(unittest.TestCase):
    def setUp(self):
        self.db = connect()
        self.db.row_factory = sqlite3.Row
        self.db.execute("PRAGMA foreign_keys=ON")
        for migration in MIGRATIONS:
            self.db.executescript(migration["sql"])
        self.db.executemany(
            "INSERT INTO organizations(id,name,slug,created_at) VALUES(?,?,?,1)",
            [("club-a", "Club A", "club-a"), ("club-b", "Club B", "club-b")],
        )
        self.db.executemany(
            "INSERT INTO club_memberships(id,org_id,user_id,role,display_name,is_active,created_at) VALUES(?,?,?,?,?,1,1)",
            [("m-a", "club-a", "manager-a", "manager", "Manager A"),
             ("m-b", "club-b", "manager-b", "manager", "Manager B")],
        )
        self.db.executemany(
            "INSERT INTO seasons(id,org_id,name,starts_on,ends_on,created_at) VALUES(?,?,?,?,?,1)",
            [("season-a", "club-a", "Season", "2026-01-01", "2026-12-31"),
             ("season-b", "club-b", "Season", "2026-01-01", "2026-12-31")],
        )
        self.db.executemany(
            "INSERT INTO divisions(id,season_id,name,created_at) VALUES(?,?,?,1)",
            [("division-a", "season-a", "A"), ("division-b", "season-b", "B")],
        )
        self.db.executemany(
            "INSERT INTO teams(id,org_id,division_id,name,created_at) VALUES(?,?,?,?,1)",
            [("team-a", "club-a", "division-a", "Team A"), ("team-a2", "club-a", "division-a", "Team A2"), ("team-b", "club-b", "division-b", "Team B")],
        )

    def tearDown(self):
        self.db.close()

    def action(self, action_name, **values):
        params = {"__user_id": "manager-a", "__now": 10, **values}
        return self.db.execute(TOOLS[action_name]["sql"], params)

    def test_admin_writes_are_authenticated_and_role_scoped(self):
        for name in ("create_club", "bootstrap_club_admin", "create_season", "create_division", "create_venue", "create_team", "create_team_invite", "accept_team_invite"):
            with self.subTest(action=name):
                self.assertTrue(TOOLS[name]["requires_auth"])
        self.assertNotIn("auth", TOOLS["create_club"])
        self.assertIn(":__user_id", TOOLS["create_club"]["sql"])
        self.assertNotIn("auth", TOOLS["accept_team_invite"])

    def test_club_creation_records_authenticated_creator(self):
        self.db.execute(TOOLS["create_club"]["sql"], {
            "__user_id": "new-user", "__now": 10,
            "id": "new-club", "name": "New Club", "slug": "new-club",
        })
        row = self.db.execute("SELECT created_by FROM organizations WHERE id='new-club'").fetchone()
        self.assertEqual(row["created_by"], "new-user")

    def test_manager_can_create_season_only_in_own_club(self):
        self.action("create_season", id="new", org_id="club-a", name="New season", starts_on="2026-01-01", ends_on="2026-12-31", status="upcoming")
        self.action("create_season", id="cross", org_id="club-b", name="Cross", starts_on="2026-01-01", ends_on="2026-12-31", status="upcoming")
        ids = {row[0] for row in self.db.execute("SELECT id FROM seasons")}
        self.assertIn("new", ids)
        self.assertNotIn("cross", ids)

    def test_team_cannot_reference_another_clubs_division(self):
        self.action("create_team", id="bad-team", org_id="club-a", division_id="division-b", name="Bad", colour="")
        self.assertIsNone(self.db.execute("SELECT id FROM teams WHERE id='bad-team'").fetchone())

    def test_manager_can_create_division_and_venue_only_in_own_club(self):
        self.action("create_division", id="new-division", season_id="season-a", name="New division", format="singles")
        self.action("create_division", id="cross-division", season_id="season-b", name="Cross club", format="singles")
        self.action("create_venue", id="new-venue", org_id="club-a", name="Home courts", address="1 Court Rd", map_url="", notes="", convenor_phone="")
        self.action("create_venue", id="cross-venue", org_id="club-b", name="Other courts", address="", map_url="", notes="", convenor_phone="")

        divisions = {row[0] for row in self.db.execute("SELECT id FROM divisions")}
        venues = {row[0] for row in self.db.execute("SELECT id FROM venues")}
        self.assertIn("new-division", divisions)
        self.assertNotIn("cross-division", divisions)
        self.assertIn("new-venue", venues)
        self.assertNotIn("cross-venue", venues)

    def test_invite_claim_creates_one_team_scoped_membership(self):
        self.action("create_team_invite", id="pending", team_id="team-a", invite_token="secret-token")
        self.action("accept_team_invite", claim_token="secret-token", display_name="Player One")
        self.assertEqual(tuple(self.db.execute("SELECT user_id,team_id FROM team_memberships").fetchone()), ("manager-a", "team-a"))
        self.action("accept_team_invite", claim_token="secret-token", display_name="Other")
        self.assertEqual(self.db.execute("SELECT user_id FROM team_memberships").fetchone()[0], "manager-a")
        self.action("accept_team_invite", claim_token="wrong-token", display_name="Other")
        self.assertEqual(self.db.execute("SELECT user_id FROM team_memberships").fetchone()[0], "manager-a")

    def test_fixture_query_returns_only_fixtures_for_member_teams(self):
        self.db.executemany(
            "INSERT INTO fixtures(id,org_id,division_id,home_team_id,away_team_id,starts_at,created_at) VALUES(?,?,?,?,?,?,1)",
            [("fixture-a", "club-a", "division-a", "team-a", "team-a2", "2026-10-01T09:00:00+10:00"),
             ("fixture-b", "club-b", "division-b", "team-b", "team-b", "2026-10-02T09:00:00+10:00"),
             ("corrupt", "club-a", "division-a", "team-a", "team-b", "2026-10-03T09:00:00+10:00")],
        )
        self.db.execute("INSERT INTO team_memberships(id,org_id,team_id,user_id,created_by,accepted_at,created_at) VALUES('accepted','club-a','team-a','player-a','manager-a',1,1)")
        rows = self.db.execute(TOOLS["list_my_fixtures"]["sql"], {"__user_id": "player-a", "from": "2026-01-01", "limit": 50}).fetchall()
        self.assertEqual([row["id"] for row in rows], ["fixture-a"])
        # Corrupt/imported rows may associate one club's fixture with another club's team.
        # Even a member of the foreign team must not see that fixture.
        self.db.execute("INSERT INTO team_memberships(id,org_id,team_id,user_id,created_by,accepted_at,created_at) VALUES('foreign-member','club-b','team-b','player-b','manager-b',1,1)")
        foreign_rows = self.db.execute(TOOLS["list_my_fixtures"]["sql"], {"__user_id": "player-b", "from": "2026-01-01", "limit": 50}).fetchall()
        self.assertEqual([row["id"] for row in foreign_rows], ["fixture-b"])
        outsider = self.db.execute(TOOLS["list_my_fixtures"]["sql"], {"__user_id": "outsider", "from": "2026-01-01", "limit": 50}).fetchall()
        self.assertEqual(outsider, [])

    def test_player_fixture_reads_do_not_select_private_contacts(self):
        sql = TOOLS["list_my_fixtures"]["sql"].lower()
        self.assertNotIn("contact", sql)
        self.assertNotIn("email", sql)


if __name__ == "__main__":
    unittest.main()

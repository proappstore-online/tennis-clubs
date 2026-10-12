import json
import sqlite3
import unittest
from pathlib import Path

from mcp_harness import connect
from test_fixture_roster_import import OPTIONS, run_import_logic

ROOT = Path(__file__).resolve().parents[1]
MIGRATIONS = json.loads((ROOT / "migrations.json").read_text())["migrations"]
TOOLS = {tool["name"]: tool for tool in json.loads((ROOT / "mcp.json").read_text())["tools"]}

SEED = """
INSERT INTO organizations(id,name,slug,created_at,created_by) VALUES ('a','Club A','club-a',1,'founder-a'),('b','Club B','club-b',1,'founder-b');
INSERT INTO club_memberships(id,org_id,user_id,role,display_name,is_active,created_at) VALUES
  ('m1','a','conv-a','convenor','Convenor A',1,1),
  ('m2','a','play-a','player','Player A',1,1),
  ('m3','a','par-a','parent','Parent A',1,1),
  ('m4','b','mgr-b','manager','Manager B',1,1);
INSERT INTO seasons(id,org_id,name,starts_on,ends_on,status,created_at) VALUES ('sa','a','Season A','2026-01-01','2026-12-31','upcoming',1);
INSERT INTO divisions(id,season_id,name,format,created_at) VALUES ('da','sa','Div A',NULL,1);
INSERT INTO teams(id,org_id,division_id,name,colour,created_at) VALUES ('ta','a','da','Team A',NULL,1),('tb','a','da','Team B',NULL,1);
INSERT INTO venues(id,org_id,name,address,map_url,notes,convenor_phone,created_at) VALUES ('va','a','Courts A',NULL,NULL,NULL,'0400000001',1);
INSERT INTO team_memberships(id,org_id,team_id,user_id,display_name,invite_token,created_by,accepted_at,created_at) VALUES ('tm1','a','ta','play-a','Player A',NULL,'conv-a',1,1);
"""


class ExternalClubTests(unittest.TestCase):
    def setUp(self):
        self.db = connect()
        self.db.row_factory = sqlite3.Row
        for migration in MIGRATIONS:
            self.db.executescript(migration["sql"])
        self.db.executescript(SEED)

    def tearDown(self):
        self.db.close()

    def run_action(self, tool, user, **params):
        return self.db.execute(TOOLS[tool]["sql"], {"__user_id": user, "__now": 1000, **params})

    def rows(self, tool, user, **params):
        return [dict(row) for row in self.run_action(tool, user, **params).fetchall()]

    def create_rival(self, user="conv-a", club="a", external_id="ec-rival", name="Rival Club", placeholder_id="tx-rival"):
        self.assertEqual(self.run_action("create_external_club", user, id=external_id, org_id=club, canonical_name=name).rowcount, 1)
        self.assertEqual(self.run_action("create_external_club_placeholder", user, id=placeholder_id, org_id=club, external_club_id=external_id).rowcount, 1)
        return placeholder_id

    def test_create_external_club_and_list(self):
        placeholder = self.create_rival(name="  Lakeside Club ")
        self.assertEqual(self.run_action("add_external_club_alias", "conv-a", id="al-1", org_id="a", external_club_id="ec-rival", alias="Lakeside CC").rowcount, 1)
        self.assertEqual(self.run_action("set_external_club_home_venue", "conv-a", org_id="a", external_club_id="ec-rival", venue_id="va").rowcount, 1)
        clubs = self.rows("list_external_clubs", "play-a", org_id="a")
        self.assertEqual(len(clubs), 1)
        self.assertEqual(clubs[0]["canonical_name"], "Lakeside Club")
        self.assertEqual(clubs[0]["normalized_name"], "lakeside club")
        self.assertEqual(clubs[0]["aliases"], "Lakeside CC")
        self.assertEqual(clubs[0]["home_venue_name"], "Courts A")
        self.assertNotIn("convenor_phone", clubs[0])
        placeholder_row = self.db.execute("SELECT name,is_external,external_club_id FROM teams WHERE id=?", (placeholder,)).fetchone()
        self.assertEqual(tuple(placeholder_row), ("Lakeside Club", 1, "ec-rival"))
        self.assertEqual(self.rows("list_external_clubs", "outsider", org_id="a"), [])

    def test_external_club_alias_matching_in_import(self):
        options = OPTIONS + [
            {"kind": "external_club", "id": "team-rival", "name": "Rival Club", "org_id": "club-1", "aliases": "rc|rival cc"},
        ]
        rows = run_import_logic(
            "date,round,opponent,home_away,venue,team,season\n"
            "2026-05-02,R1,  RC ,home,Central Courts,Northside,2026\n"
            "2026-05-09,R2,Rival  CC,away,Central Courts,Northside,2026\n"
            "2026-05-16,R3,rival club,home,Central Courts,Northside,2026\n",
            options,
        )
        self.assertEqual([row["away_team_id"] for row in rows], ["team-rival", "team-home", "team-rival"])
        self.assertEqual([row["issue"] for row in rows], ["", "", ""])
        self.assertEqual(rows[1]["home_team_id"], "team-rival")
        unmatched = run_import_logic(
            "date,round,opponent,home_away,venue,team,season\n2026-05-02,R1,Nobody FC,home,Central Courts,Northside,2026\n",
            options,
        )
        self.assertIn("opponent team not found", unmatched[0]["issue"])

    def test_placeholder_team_hidden_from_team_list(self):
        placeholder = self.create_rival()
        teams = {row["id"] for row in self.rows("list_club_teams", "conv-a", org_id="a")}
        self.assertEqual(teams, {"ta", "tb"})
        options = self.rows("list_fixture_import_options", "conv-a")
        self.assertNotIn(placeholder, [row["id"] for row in options if row["kind"] == "team"])
        external = [row for row in options if row["kind"] == "external_club"]
        self.assertEqual([(row["id"], row["name"]) for row in external], [(placeholder, "Rival Club")])
        self.assertEqual(self.run_action("create_team_invite", "conv-a", id="inv-x", team_id=placeholder, invite_token="tok-x").rowcount, 0)
        self.assertEqual(self.run_action("create_team_invite", "conv-a", id="inv-y", team_id="ta", invite_token="tok-y").rowcount, 1)

    def test_external_club_admin_permission(self):
        placeholder_args = {"id": "tx-z", "org_id": "a", "external_club_id": "ec-z"}
        for user in ("play-a", "par-a", "mgr-b", "outsider"):
            with self.subTest(user=user):
                self.assertEqual(self.run_action("create_external_club", user, id="ec-z", org_id="a", canonical_name="Zed").rowcount, 0)
                self.assertEqual(self.db.execute("SELECT COUNT(*) FROM external_clubs WHERE id='ec-z'").fetchone()[0], 0)
                self.assertEqual(self.run_action("create_external_club_placeholder", user, **placeholder_args).rowcount, 0)
                self.assertEqual(self.run_action("add_external_club_alias", user, id="al-z", org_id="a", external_club_id="ec-z", alias="Zed").rowcount, 0)
                self.assertEqual(self.run_action("set_external_club_home_venue", user, org_id="a", external_club_id="ec-z", venue_id="va").rowcount, 0)
                self.assertEqual(self.run_action("schedule_fixture", user, id="f-z", org_id="a", division_id="da", home_team_id="ta", away_team_id="tb", venue_id=None, starts_at="2026-12-01T09:00:00+11:00", round_label=None).rowcount, 0)
        self.assertEqual(self.run_action("create_external_club", "conv-a", id="ec-ok", org_id="a", canonical_name="Okay").rowcount, 1)

    def test_schedule_fixture_with_external_opponent(self):
        placeholder = self.create_rival()
        scheduled = self.run_action("schedule_fixture", "conv-a", id="f-ext", org_id="a", division_id="da", home_team_id="ta", away_team_id=placeholder, venue_id="va", starts_at="2026-12-01T09:00:00+11:00", round_label="R9")
        self.assertEqual(scheduled.rowcount, 1)
        status = self.db.execute("SELECT status FROM fixtures WHERE id='f-ext'").fetchone()[0]
        self.assertEqual(status, "scheduled")
        managed = self.rows("list_managed_fixtures", "conv-a")[0]
        self.assertEqual((managed["opponent_name"], managed["is_external_opponent"], managed["away_team_name"]), ("Rival Club", 1, "Rival Club"))
        mine = self.rows("list_my_fixtures", "play-a", **{"from": "2026-01-01"})
        self.assertEqual(len(mine), 1)
        self.assertEqual((mine[0]["member_side"], mine[0]["opponent_name"], mine[0]["is_external_opponent"]), ("home", "Rival Club", 1))
        self.assertEqual(self.run_action("schedule_fixture", "conv-a", id="f-bad", org_id="a", division_id="da", home_team_id=placeholder, away_team_id="tb", venue_id="va", starts_at="2026-12-02T09:00:00+11:00", round_label=None).rowcount, 0)
        self.assertEqual(self.run_action("schedule_fixture", "conv-a", id="f-same", org_id="a", division_id="da", home_team_id="ta", away_team_id="ta", venue_id="va", starts_at="2026-12-03T09:00:00+11:00", round_label=None).rowcount, 0)

    def test_same_alias_allowed_across_clubs_but_not_within_one_club(self):
        self.create_rival(external_id="ec-a", name="Rival A", placeholder_id="tx-a")
        self.create_rival(user="mgr-b", club="b", external_id="ec-b", name="Rival B", placeholder_id="tx-b")
        self.assertEqual(self.run_action("add_external_club_alias", "conv-a", id="al-a", org_id="a", external_club_id="ec-a", alias="Lakeside CC").rowcount, 1)
        self.assertEqual(self.run_action("add_external_club_alias", "mgr-b", id="al-b", org_id="b", external_club_id="ec-b", alias="Lakeside CC").rowcount, 1)
        with self.assertRaises(sqlite3.IntegrityError):
            self.run_action("add_external_club_alias", "conv-a", id="al-dup", org_id="a", external_club_id="ec-a", alias="  lakeside   cc ")
        self.assertEqual(self.run_action("add_external_club_alias", "conv-a", id="al-clash", org_id="a", external_club_id="ec-a", alias="Rival A").rowcount, 0)


if __name__ == "__main__":
    unittest.main()

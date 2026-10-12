import json
import sqlite3
import unittest
from pathlib import Path

from mcp_harness import connect

ROOT = Path(__file__).resolve().parents[1]
MIGRATIONS = json.loads((ROOT / "migrations.json").read_text())["migrations"]
TOOLS = {tool["name"]: tool for tool in json.loads((ROOT / "mcp.json").read_text())["tools"]}

SEED = """
INSERT INTO organizations(id,name,slug,created_at,created_by) VALUES ('a','Club A','club-a',1,'founder-a'),('b','Club B','club-b',1,'founder-b');
INSERT INTO club_memberships(id,org_id,user_id,role,display_name,is_active,created_at) VALUES
  ('m1','a','conv-a','convenor','Convenor A',1,1),
  ('m2','a','par-a','parent','Parent A',1,1),
  ('m3','b','mgr-b','manager','Manager B',1,1),
  ('m4','a','reg-a','player','Regular A',1,1),
  ('m5','a','emer-a','player','Emergency A',1,1);
INSERT INTO seasons(id,org_id,name,starts_on,ends_on,status,created_at) VALUES ('sa','a','Season A','2026-01-01','2026-12-31','upcoming',1),('sb','b','Season B','2026-01-01','2026-12-31','upcoming',1);
INSERT INTO divisions(id,season_id,name,format,created_at) VALUES ('da','sa','Div A',NULL,1),('db','sb','Div B',NULL,1);
INSERT INTO teams(id,org_id,division_id,name,colour,created_at) VALUES ('ta','a','da','Team A',NULL,1),('tb','a','da','Team B',NULL,1),('tc','b','db','Team C',NULL,1),('td','b','db','Team D',NULL,1);
INSERT INTO fixtures(id,org_id,division_id,home_team_id,away_team_id,starts_at,round_label,status,created_at) VALUES
  ('fa','a','da','ta','tb','2026-10-11T09:00:00+11:00','R1','scheduled',1),
  ('fb','b','db','tc','td','2026-10-11T09:00:00+11:00','R1','scheduled',1);
INSERT INTO team_memberships(id,org_id,team_id,user_id,display_name,invite_token,created_by,accepted_at,created_at) VALUES
  ('tm-reg','a','ta','reg-a','Regular A',NULL,'conv-a',1,1),
  ('tm-emer','a','ta','emer-a','Emergency A',NULL,'conv-a',1,1),
  ('tm-b','b','tc','reg-b','Regular B',NULL,'mgr-b',1,1);
"""

REGULAR = "reg-a"
EMERGENCY = "emer-a"


class SquadPoolTests(unittest.TestCase):
    def setUp(self):
        self.db = connect()
        self.db.row_factory = sqlite3.Row
        for migration in MIGRATIONS:
            self.db.executescript(migration["sql"])
        self.db.executescript(SEED)
        self.history_id = 0

    def tearDown(self):
        self.db.close()

    def run_action(self, tool, user, **params):
        return self.db.execute(TOOLS[tool]["sql"], {"__user_id": user, "__now": 1000, **params})

    def rows(self, tool, user, **params):
        return [dict(row) for row in self.run_action(tool, user, **params).fetchall()]

    def next_id(self, prefix):
        self.history_id += 1
        return f"{prefix}-{self.history_id}"

    def select(self, user, player, selection, fixture="fa", team_side=None):
        return self.run_action("add_fixture_roster_player", user, fixture_id=fixture, user_id=player, selection=selection)

    def test_regular_and_emergency_pools_are_set_per_team_member(self):
        self.assertEqual(self.run_action("set_team_player_pool", "conv-a", org_id="a", team_id="ta", user_id=EMERGENCY, pool="emergency").rowcount, 1)
        pools = {row["user_id"]: row["pool"] for row in self.rows("list_team_pool", "conv-a", org_id="a", team_id="ta")}
        self.assertEqual(pools, {REGULAR: "regular", EMERGENCY: "emergency"})
        self.assertEqual(self.run_action("set_team_player_pool", "conv-a", org_id="a", team_id="ta", user_id="outsider", pool="regular").rowcount, 0)
        self.assertEqual(self.run_action("set_team_player_pool", "conv-a", org_id="a", team_id="ta", user_id=REGULAR, pool="reserve").rowcount, 0)

    def test_members_see_only_their_own_squad_row(self):
        own = self.rows("list_team_pool", EMERGENCY, org_id="a", team_id="ta")
        self.assertEqual([row["user_id"] for row in own], [EMERGENCY])
        self.assertEqual(self.rows("list_team_pool", "par-a", org_id="a", team_id="ta"), [])
        self.assertEqual(self.rows("list_team_pool", "mgr-b", org_id="a", team_id="ta"), [])
        self.assertEqual(self.rows("list_fixture_team_candidates", REGULAR, fixture_id="fa"), [])

    def test_emergency_players_are_called_up_not_selected(self):
        self.run_action("set_team_player_pool", "conv-a", org_id="a", team_id="ta", user_id=EMERGENCY, pool="emergency")
        self.assertEqual(self.select("conv-a", EMERGENCY, "selected").rowcount, 0)
        self.assertEqual(self.select("conv-a", EMERGENCY, "pending").rowcount, 0)
        self.assertEqual(self.select("conv-a", EMERGENCY, "emergency_call_up").rowcount, 1)
        self.assertEqual(self.select("conv-a", REGULAR, "emergency_call_up").rowcount, 0)
        self.assertEqual(self.select("conv-a", REGULAR, "selected").rowcount, 1)
        self.assertEqual(self.select("conv-a", REGULAR, "maybe").rowcount, 0)
        states = {row["user_id"]: (row["selection"], row["pool"]) for row in self.rows("list_managed_fixture_roster", "conv-a", fixture_id="fa")}
        self.assertEqual(states, {EMERGENCY: ("emergency_call_up", "emergency"), REGULAR: ("selected", "regular")})

    def test_selection_states_are_idempotent_and_roster_lists_only_selected_players(self):
        self.assertEqual(self.select("conv-a", REGULAR, "selected").rowcount, 1)
        self.assertEqual(self.select("conv-a", REGULAR, "selected").rowcount, 1)
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM fixture_roster WHERE fixture_id='fa'").fetchone()[0], 1)
        self.assertEqual(self.select("conv-a", REGULAR, "unavailable").rowcount, 1)
        self.assertEqual(self.db.execute("SELECT selection FROM fixture_roster WHERE user_id=?", (REGULAR,)).fetchone()[0], "unavailable")
        roster = {row["user_id"]: row["selection"] for row in self.rows("list_fixture_roster", REGULAR, fixture_id="fa")}
        self.assertEqual(roster, {REGULAR: "unavailable"})
        self.assertEqual(self.run_action("set_team_player_pool", "conv-a", org_id="a", team_id="ta", user_id=EMERGENCY, pool="emergency").rowcount, 1)
        self.assertEqual(self.run_action("set_team_player_pool", "conv-a", org_id="a", team_id="ta", user_id=EMERGENCY, pool="emergency").rowcount, 1)
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM team_players WHERE team_id='ta' AND user_id=?", (EMERGENCY,)).fetchone()[0], 1)

    def test_selection_and_pool_history_record_actor_and_change(self):
        self.select("conv-a", REGULAR, "selected")
        self.run_action("log_fixture_selection_change", "conv-a", id=self.next_id("sh"), org_id="a", fixture_id="fa", user_id=REGULAR, old_selection=None)
        self.select("conv-a", REGULAR, "unavailable")
        self.run_action("log_fixture_selection_change", "conv-a", id=self.next_id("sh"), org_id="a", fixture_id="fa", user_id=REGULAR, old_selection="selected")
        history = self.rows("list_fixture_selection_history", "conv-a", org_id="a", fixture_id="fa")
        self.assertEqual([(row["old_selection"], row["new_selection"], row["actor_user_id"]) for row in history],
                         [("selected", "unavailable", "conv-a"), (None, "selected", "conv-a")])
        self.assertEqual(self.rows("list_fixture_selection_history", REGULAR, org_id="a", fixture_id="fa"), [])
        self.assertEqual(self.run_action("log_fixture_selection_change", "conv-a", id=self.next_id("sh"), org_id="a", fixture_id="fa", user_id=REGULAR, old_selection="unavailable").rowcount, 0)

        self.run_action("set_team_player_pool", "conv-a", org_id="a", team_id="ta", user_id=EMERGENCY, pool="emergency")
        self.run_action("log_team_pool_change", "conv-a", id=self.next_id("ph"), org_id="a", team_id="ta", user_id=EMERGENCY, display_name="Emergency A", action="pool_set", old_pool="regular", new_pool="emergency")
        self.run_action("deactivate_team_player", "conv-a", org_id="a", team_id="ta", user_id=EMERGENCY)
        self.run_action("log_team_pool_change", "conv-a", id=self.next_id("ph"), org_id="a", team_id="ta", user_id=EMERGENCY, display_name="Emergency A", action="deactivated", old_pool="emergency", new_pool=None)
        pool_history = self.rows("list_team_pool_history", "conv-a", org_id="a", team_id="ta")
        self.assertEqual([(row["action"], row["actor_user_id"]) for row in pool_history], [("deactivated", "conv-a"), ("pool_set", "conv-a")])
        self.assertEqual(self.rows("list_team_pool_history", EMERGENCY, org_id="a", team_id="ta"), [])

    def test_deactivated_squad_member_cannot_be_selected_until_reinstated(self):
        self.run_action("deactivate_team_player", "conv-a", org_id="a", team_id="ta", user_id=REGULAR)
        self.assertEqual(self.select("conv-a", REGULAR, "selected").rowcount, 0)
        self.assertEqual([row["user_id"] for row in self.rows("list_fixture_team_candidates", "conv-a", fixture_id="fa")], [EMERGENCY])
        self.run_action("set_team_player_pool", "conv-a", org_id="a", team_id="ta", user_id=REGULAR, pool="regular")
        self.assertEqual(self.select("conv-a", REGULAR, "selected").rowcount, 1)

    def test_squad_writes_are_limited_to_club_managers_of_the_team(self):
        for user in ("reg-a", "par-a", "mgr-b", "outsider"):
            with self.subTest(user=user):
                self.assertEqual(self.run_action("set_team_player_pool", user, org_id="a", team_id="ta", user_id=REGULAR, pool="emergency").rowcount, 0)
                self.assertEqual(self.run_action("deactivate_team_player", user, org_id="a", team_id="ta", user_id=REGULAR).rowcount, 0)
                self.assertEqual(self.run_action("log_team_pool_change", user, id=self.next_id("ph"), org_id="a", team_id="ta", user_id=REGULAR, display_name="x", action="pool_set", old_pool=None, new_pool="regular").rowcount, 0)
                self.assertEqual(self.select(user, REGULAR, "selected").rowcount, 0)
        self.assertEqual(self.select("mgr-b", REGULAR, "selected", fixture="fa").rowcount, 0)
        self.assertEqual(self.select("conv-a", "reg-b", "selected", fixture="fb").rowcount, 0)
        self.assertEqual(self.run_action("set_team_player_pool", "conv-a", org_id="a", team_id="tc", user_id="reg-b", pool="regular").rowcount, 0)

    def test_squad_and_roster_reads_expose_no_contact_details(self):
        for tool in ("list_team_pool", "list_fixture_roster", "list_managed_fixture_roster", "list_fixture_team_candidates", "list_team_pool_history", "list_fixture_selection_history"):
            sql = TOOLS[tool]["sql"].lower()
            with self.subTest(action=tool):
                for banned in ("contact", "email", "phone"):
                    self.assertNotIn(banned, sql)

    def test_existing_roster_rows_default_to_selected_regular(self):
        """Migration 0010 must leave pre-existing rows valid: selected state, no pool recorded."""
        db = connect()
        db.row_factory = sqlite3.Row
        for migration in MIGRATIONS[:-1]:
            db.executescript(migration["sql"])
        db.executescript(SEED)
        db.execute("INSERT INTO fixture_roster(fixture_id,user_id,display_name,availability,confirmed_at) VALUES ('fa','reg-a','Regular A','in',1)")
        db.executescript(MIGRATIONS[-1]["sql"])
        row = db.execute("SELECT selection,pool,availability FROM fixture_roster WHERE user_id='reg-a'").fetchone()
        self.assertEqual(tuple(row), ("selected", None, "in"))
        db.close()


if __name__ == "__main__":
    unittest.main()

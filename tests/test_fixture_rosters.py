import json
import sqlite3
import unittest
from pathlib import Path

from mcp_harness import connect

ROOT = Path(__file__).resolve().parents[1]
MIGRATIONS = json.loads((ROOT / "migrations.json").read_text())["migrations"]
TOOLS = {tool["name"]: tool for tool in json.loads((ROOT / "mcp.json").read_text())["tools"]}


class FixtureRosterTests(unittest.TestCase):
    def setUp(self):
        self.db = connect()
        self.db.row_factory = sqlite3.Row
        self.db.execute("PRAGMA foreign_keys=ON")
        for migration in MIGRATIONS:
            self.db.executescript(migration["sql"])
        self.db.executemany("INSERT INTO organizations(id,name,slug,created_at) VALUES(?,?,?,1)", [("a", "A", "a"), ("b", "B", "b")])
        self.db.executemany("INSERT INTO club_memberships(id,org_id,user_id,role,display_name,is_active,created_at) VALUES(?,?,?,?,?,1,1)", [("ma", "a", "manager", "manager", "Manager"), ("mb", "b", "other-manager", "manager", "Other")])
        self.db.executemany("INSERT INTO teams(id,org_id,name,created_at) VALUES(?,?,?,1)", [("ta", "a", "Team A"), ("tb", "a", "Team B"), ("tc", "b", "Team C")])
        self.db.executemany("INSERT INTO fixtures(id,org_id,home_team_id,away_team_id,starts_at,created_at) VALUES(?,?,?,?,?,1)", [("fa", "a", "ta", "tb", "2026-10-11T09:00:00+11:00"), ("fb", "b", "tc", "tc", "2026-10-11T09:00:00+11:00")])
        self.db.executemany("INSERT INTO team_memberships(id,org_id,team_id,user_id,display_name,created_by,accepted_at,created_at) VALUES(?,?,?,?,?,?,1,1)", [("p1", "a", "ta", "player-1", "Player One", "manager"), ("p2", "a", "tb", "player-2", "Player Two", "manager"), ("p3", "b", "tc", "player-3", "Player Three", "other-manager")])

    def tearDown(self):
        self.db.close()

    def call(self, name, user="manager", **values):
        params = {"__user_id": user, "__now": 1234, **values}
        old_availability = None
        if name == "set_my_fixture_availability":
            old = self.db.execute(
                "SELECT availability FROM fixture_roster WHERE fixture_id=? AND user_id=?",
                (values["fixture_id"], user),
            ).fetchone()
            old_availability = old["availability"] if old else None
        elif name == "remove_fixture_roster_player":
            old = self.db.execute(
                "SELECT availability FROM fixture_roster WHERE fixture_id=? AND user_id=?",
                (values["fixture_id"], values["user_id"]),
            ).fetchone()
            old_availability = old["availability"] if old else None
        result = self.db.execute(TOOLS[name]["sql"], params)
        if name == "add_fixture_roster_player" and result.rowcount:
            self.db.execute(TOOLS["log_fixture_roster_added"]["sql"], params)
        elif name == "remove_fixture_roster_player" and result.rowcount and old_availability:
            self.db.execute(TOOLS["log_fixture_roster_removed"]["sql"], {**params, "old_availability": old_availability})
        elif name == "set_my_fixture_availability" and result.rowcount and old_availability:
            new_availability = "pending" if values["availability"] == "not_sure" else values["availability"]
            if old_availability != new_availability:
                self.db.execute(TOOLS["log_my_fixture_availability_change"]["sql"], {
                    "__user_id": user, "__now": 1234, "fixture_id": values["fixture_id"],
                    "old_availability": old_availability, "new_availability": new_availability,
                })
        return result

    def test_roster_import_matches_team_and_opponent_names_as_the_fixture_book_does(self):
        # The fixture book ignores case and surrounding spaces in names; the roster import must match the same way or it drops rows without an error.
        self.db.execute("UPDATE fixtures SET round_label='R1' WHERE id='fa'")
        result = self.db.execute(TOOLS["upsert_imported_roster_player"]["sql"], {"__user_id": "manager", "__now": 1234, "id": "imp-1", "org_id": "a", "starts_at": "2026-10-11T09:00:00+11:00", "round_label": "R1", "team": " team a ", "opponent": "TEAM B", "player_name": "Pat Player"})
        self.assertEqual(result.rowcount, 1)
        self.assertEqual(self.db.execute("SELECT player_name FROM roster_players WHERE fixture_id='fa'").fetchone()[0], "Pat Player")

    def test_registered_roster_actions_require_auth(self):
        names = ("list_managed_fixtures", "list_managed_fixture_roster", "list_fixture_team_candidates", "add_fixture_roster_player", "log_fixture_roster_added", "remove_fixture_roster_player", "log_fixture_roster_removed", "list_fixture_roster_activity", "list_fixture_roster", "set_my_fixture_availability", "log_my_fixture_availability_change")
        self.assertTrue(all(TOOLS[name]["requires_auth"] for name in names))

    def test_activity_migration_has_no_trigger_statements(self):
        activity = next(m for m in MIGRATIONS if m["name"] == "0004_fixture_roster_activity")
        self.assertNotIn("TRIGGER", activity["sql"].upper())
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM sqlite_master WHERE type='trigger'").fetchone()[0], 0)

    def test_manager_add_remove_are_limited_to_managed_fixture_and_team_member(self):
        self.call("add_fixture_roster_player", fixture_id="fa", user_id="player-1")
        self.call("add_fixture_roster_player", fixture_id="fa", user_id="player-3")
        self.call("add_fixture_roster_player", fixture_id="fb", user_id="player-3")
        rows = self.db.execute("SELECT fixture_id,user_id FROM fixture_roster ORDER BY fixture_id,user_id").fetchall()
        self.assertEqual([tuple(row) for row in rows], [("fa", "player-1")])
        self.call("remove_fixture_roster_player", fixture_id="fa", user_id="player-1")
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM fixture_roster").fetchone()[0], 0)
        removed = self.db.execute("SELECT action,old_availability,actor_user_id FROM fixture_roster_activity WHERE action='removed'").fetchone()
        self.assertEqual(tuple(removed), ("removed", "pending", "manager"))

    def test_player_changes_only_own_rostered_status_and_change_is_audited(self):
        self.call("add_fixture_roster_player", fixture_id="fa", user_id="player-1")
        self.call("add_fixture_roster_player", fixture_id="fa", user_id="player-2")
        self.call("set_my_fixture_availability", user="player-1", fixture_id="fa", availability="in")
        self.call("set_my_fixture_availability", user="player-2", fixture_id="fa", availability="out")
        self.call("set_my_fixture_availability", user="player-1", fixture_id="fa", availability="not_sure")
        rows = {r["user_id"]: r["availability"] for r in self.db.execute("SELECT user_id,availability FROM fixture_roster")}
        self.assertEqual(rows, {"player-1": "pending", "player-2": "out"})
        changes = self.db.execute("SELECT action,old_availability,new_availability,actor_user_id FROM fixture_roster_activity WHERE user_id='player-1' ORDER BY id").fetchall()
        self.assertEqual([tuple(r) for r in changes], [("added", None, "pending", "manager"), ("availability_changed", "pending", "in", "player-1"), ("availability_changed", "in", "pending", "player-1")])

    def test_manager_counts_and_activity_exclude_other_clubs(self):
        self.call("add_fixture_roster_player", fixture_id="fa", user_id="player-1")
        self.call("add_fixture_roster_player", fixture_id="fb", user_id="player-3", user="other-manager")
        counts = self.call("list_managed_fixtures").fetchall()
        self.assertEqual(len(counts), 1)
        self.assertEqual((counts[0]["in_count"], counts[0]["out_count"], counts[0]["pending_count"]), (0, 0, 1))
        activity = self.call("list_fixture_roster_activity", fixture_id="fb").fetchall()
        self.assertEqual(activity, [])

    def test_player_roster_read_is_scoped_to_fixture_team(self):
        self.call("add_fixture_roster_player", fixture_id="fa", user_id="player-1")
        self.assertEqual(len(self.call("list_fixture_roster", user="player-1", fixture_id="fa").fetchall()), 1)
        self.assertEqual(self.call("list_fixture_roster", user="player-3", fixture_id="fa").fetchall(), [])

    def test_cross_club_fixture_reference_cannot_leak_roster_or_change_availability(self):
        # Legacy/imported data can contain a fixture owned by club A that points to club B's team.
        self.db.execute("INSERT INTO fixtures(id,org_id,home_team_id,away_team_id,starts_at,created_at) VALUES('corrupt','a','tc','ta','2026-10-12T09:00:00+11:00',1)")
        self.db.execute("INSERT INTO fixture_roster(fixture_id,user_id,display_name,availability) VALUES('corrupt','player-3','Player Three','pending')")
        self.assertEqual(self.call("list_fixture_roster", user="player-3", fixture_id="corrupt").fetchall(), [])
        self.assertEqual(self.call("list_managed_fixture_roster", fixture_id="corrupt").fetchall(), [])
        self.assertEqual(self.call("list_fixture_roster_activity", fixture_id="corrupt").fetchall(), [])
        self.call("set_my_fixture_availability", user="player-3", fixture_id="corrupt", availability="in")
        self.assertEqual(self.db.execute("SELECT availability FROM fixture_roster WHERE fixture_id='corrupt'").fetchone()[0], "pending")

    def test_manager_roster_reads_and_candidates_are_club_scoped(self):
        self.call("add_fixture_roster_player", fixture_id="fa", user_id="player-1")
        own = self.call("list_managed_fixture_roster", fixture_id="fa").fetchall()
        candidates = self.call("list_fixture_team_candidates", fixture_id="fa").fetchall()
        self.assertEqual([row["user_id"] for row in own], ["player-1"])
        self.assertEqual({row["user_id"] for row in candidates}, {"player-1", "player-2"})
        self.assertEqual(self.call("list_managed_fixture_roster", fixture_id="fb").fetchall(), [])
        self.assertEqual(self.call("list_fixture_team_candidates", fixture_id="fb").fetchall(), [])

    def test_non_manager_cannot_add_or_remove_roster_players(self):
        self.call("add_fixture_roster_player", fixture_id="fa", user_id="player-1", user="player-1")
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM fixture_roster").fetchone()[0], 0)
        self.call("add_fixture_roster_player", fixture_id="fa", user_id="player-1")
        self.call("remove_fixture_roster_player", fixture_id="fa", user_id="player-1", user="player-1")
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM fixture_roster").fetchone()[0], 1)

    def test_availability_update_is_self_only_and_requires_roster_membership(self):
        self.call("add_fixture_roster_player", fixture_id="fa", user_id="player-1")
        self.call("add_fixture_roster_player", fixture_id="fa", user_id="player-2")
        self.call("set_my_fixture_availability", user="player-1", fixture_id="fa", availability="out", user_id="player-2")
        rows = {r["user_id"]: r["availability"] for r in self.db.execute("SELECT user_id,availability FROM fixture_roster")}
        self.assertEqual(rows, {"player-1": "out", "player-2": "pending"})
        self.call("set_my_fixture_availability", user="player-3", fixture_id="fa", availability="in")
        rows = {r["user_id"]: r["availability"] for r in self.db.execute("SELECT user_id,availability FROM fixture_roster")}
        self.assertEqual(rows, {"player-1": "out", "player-2": "pending"})

    def test_mobile_controls_and_map_link_meet_touch_target_minimum(self):
        css = (ROOT / "web/src/index.css").read_text()
        app = (ROOT / "web/src/App.tsx").read_text()
        self.assertIn("button, input, select, textarea {\n  min-height: 44px;", css)
        self.assertIn("inline-flex min-h-11 items-center", app)
        roster_admin = (ROOT / "web/src/pages/RosterAdmin.tsx").read_text()
        self.assertIn("log_fixture_roster_added", roster_admin)
        self.assertIn("log_fixture_roster_removed", roster_admin)
        self.assertIn("log_my_fixture_availability_change", app)


if __name__ == "__main__":
    unittest.main()

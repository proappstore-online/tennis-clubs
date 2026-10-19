import json
import sqlite3
import unittest
from pathlib import Path

from mcp_harness import connect

ROOT = Path(__file__).resolve().parents[1]
MIGRATIONS = json.loads((ROOT / "migrations.json").read_text())["migrations"]
TOOLS = {tool["name"]: tool for tool in json.loads((ROOT / "mcp.json").read_text())["tools"]}
FROM = "2026-10-11T00:00:00+11:00"


class FixtureHistoryTests(unittest.TestCase):
    def setUp(self):
        self.db = connect()
        self.db.row_factory = sqlite3.Row
        for migration in MIGRATIONS:
            self.db.executescript(migration["sql"])
        self.db.execute("INSERT INTO organizations(id,name,slug,logo_url,created_at,created_by) VALUES('club','Club','club',NULL,1,NULL)")
        self.db.executemany("INSERT INTO club_memberships(id,org_id,user_id,role,display_name,is_active,created_at) VALUES(?,?,?,?,?,1,1)", [
            ("player", "club", "player", "player", "Player"), ("outsider", "club", "outsider", "player", "Outsider")])
        self.db.executemany("INSERT INTO seasons(id,org_id,name,starts_on,ends_on,status,created_at) VALUES(?,?,?,?,?,?,1)", [
            ("s1", "club", "2026", "2026-02-01", "2026-12-31", "active"), ("s2", "club", "2025", "2025-02-01", "2025-12-31", "complete")])
        self.db.executemany("INSERT INTO divisions(id,season_id,name,format,created_at) VALUES(?,?,?,NULL,1)", [("d1", "s1", "Div 1"), ("d2", "s2", "Div 2")])
        self.db.executemany("INSERT INTO teams(id,org_id,division_id,name,created_at) VALUES(?,?,?,?,1)", [
            ("home", "club", "d1", "Home"), ("away", "club", "d1", "Away"), ("x", "club", "d1", "X"), ("y", "club", "d1", "Y")])
        self.db.executemany("INSERT INTO team_memberships(id,org_id,team_id,user_id,created_by,accepted_at,created_at) VALUES(?,?,?,?,'manager',1,1)", [
            ("m1", "club", "home", "player"), ("m2", "club", "away", "player")])
        self.db.executemany("INSERT INTO fixtures(id,org_id,division_id,home_team_id,away_team_id,starts_at,status,home_score,away_score,created_at) VALUES(?,?,?,?,?,?,?,?,?,1)", [
            ("past-a", "club", "d1", "home", "away", "2026-10-10T09:00:00+11:00", "complete", 3, 5),
            ("today-b", "club", "d1", "home", "away", "2026-10-11T10:00:00+11:00", "scheduled", None, None),
            ("next-c", "club", "d1", "home", "away", "2026-10-20T09:00:00+11:00", "scheduled", None, None),
            ("as-away", "club", "d1", "x", "away", "2026-10-21T09:00:00+11:00", "scheduled", None, None),
            ("old-d", "club", "d2", "home", "away", "2025-09-01T09:00:00+10:00", "forfeit", None, None),
            ("other-e", "club", "d1", "x", "y", "2026-10-12T09:00:00+11:00", "scheduled", None, None)])

    def tearDown(self): self.db.close()

    def ids(self, user="player", **extra):
        params = {"__user_id": user, "from": FROM, "limit": 50, **extra}
        return [row["id"] for row in self.db.execute(TOOLS["list_my_fixtures"]["sql"], params).fetchall()]

    def test_past_mode_returns_past_fixtures_newest_first(self):
        self.assertEqual(self.ids(mode="past"), ["past-a", "old-d"])

    def test_upcoming_mode_excludes_past_and_is_oldest_first(self):
        self.assertEqual(self.ids(), ["today-b", "next-c", "as-away"])
        self.assertEqual(self.ids(mode="upcoming"), ["today-b", "next-c", "as-away"])

    def test_all_mode_returns_both_oldest_first(self):
        self.assertEqual(self.ids(mode="all"), ["old-d", "past-a", "today-b", "next-c", "as-away"])

    def test_season_filter_limits_to_that_season(self):
        self.assertEqual(self.ids(mode="all", season_id="s2"), ["old-d"])
        self.assertEqual(self.ids(mode="all", season_id="s1"), ["past-a", "today-b", "next-c", "as-away"])

    def test_team_filter_limits_to_fixtures_for_that_team(self):
        self.assertEqual(self.ids(team_id="x"), ["as-away"])
        self.assertEqual(self.ids(mode="all", team_id="away"), ["old-d", "past-a", "today-b", "next-c", "as-away"])

    def test_result_status_filter_limits_to_that_status(self):
        self.assertEqual(self.ids(mode="past", result_status="complete"), ["past-a"])
        self.assertEqual(self.ids(mode="past", result_status="forfeit"), ["old-d"])

    def test_date_range_filter_uses_exclusive_upper_bound(self):
        rows = self.ids(mode="all", date_from="2026-10-01T00:00:00+11:00", to="2026-10-11T00:00:00+11:00")
        self.assertEqual(rows, ["past-a"])

    def test_scorecard_and_set_detail_are_not_exposed_in_history(self):
        self.db.execute("INSERT INTO fixture_result_submissions(id,fixture_id,submitted_by,home_score,away_score,set_results,scorecard_user_id,scorecard_path,submitted_at) VALUES('s','past-a','manager',3,5,'[{\"home\":6,\"away\":4}]','manager','private/card.pdf',1)")
        rows = self.db.execute(TOOLS["list_my_fixtures"]["sql"], {"__user_id": "player", "from": FROM, "limit": 50, "mode": "past"}).fetchall()
        self.assertTrue(rows)
        for row in rows:
            self.assertNotIn("scorecard_path", row.keys())
            self.assertNotIn("set_results", row.keys())
            self.assertNotIn("private/card.pdf", [str(value) for value in tuple(row)])

    def test_member_scope_is_enforced_in_every_mode(self):
        self.assertEqual(self.ids(user="outsider", mode="all"), [])
        for mode in ("upcoming", "past", "all"):
            self.assertNotIn("other-e", self.ids(mode=mode))
        self.assertEqual(self.ids(team_id="y", mode="all"), [])


if __name__ == "__main__":
    unittest.main()

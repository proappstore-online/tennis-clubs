import json
import sqlite3
import unittest
from pathlib import Path

from mcp_harness import connect
from test_fixture_timing import CLEAN, SEED, row

ROOT = Path(__file__).resolve().parents[1]
MIGRATIONS = json.loads((ROOT / "migrations.json").read_text())["migrations"]
TOOLS = {tool["name"]: tool for tool in json.loads((ROOT / "mcp.json").read_text())["tools"]}

# Club B owns three venues: a shared one, an unshared one holding a convenor phone, and two shared venues named Oval.
# Club A owns 'Hall', so the shared 'Hall' in club B is only used when club A has no venue of that name.
EXTRA = """
INSERT INTO venues(id,org_id,name,address,map_url,notes,convenor_phone,created_at,shared) VALUES
  ('vb','b','Harbour Hall','1 Pier Rd','https://maps.example/h','Park at the rear',NULL,1,1),
  ('vc','b','Private Courts','9 Hidden St',NULL,NULL,'0400000999',1,0),
  ('vh','b','Hall','2 Old Rd',NULL,NULL,NULL,1,1),
  ('vo1','b','Oval','3 Field Rd',NULL,NULL,NULL,1,1),
  ('vo2','b','Oval','4 Field Rd',NULL,NULL,NULL,1,1),
  ('va-hall','a','Hall','5 Own Rd',NULL,NULL,NULL,1,0);
"""


class SharedVenueTests(unittest.TestCase):
    def setUp(self):
        self.db = connect()
        self.db.row_factory = sqlite3.Row
        for migration in MIGRATIONS:
            self.db.executescript(migration["sql"])
        self.db.executescript(SEED)
        self.db.executescript(EXTRA)
        self.run_action("set_contact_detail", "mgr-b", id="cd-vc", org_id="b", subject_type="venue", subject_id="vc", label="Convenor", kind="phone", value="0400 000 999")

    def tearDown(self):
        self.db.close()

    def run_action(self, tool, user, **params):
        return self.db.execute(TOOLS[tool]["sql"], {"__user_id": user, "__now": 1000, **params})

    def rows(self, tool, user, **params):
        return [dict(item) for item in self.run_action(tool, user, **params).fetchall()]

    def validate(self, rows, user="conv-a"):
        return [dict(issue) for issue in self.run_action("validate_fixture_import", user, org_id="a", rows=json.dumps(rows)).fetchall()]

    def upsert(self, venue_id, fixture_id="f-shared", user="conv-a"):
        return self.run_action("upsert_imported_fixture", user, id=fixture_id, org_id="a", home_team_id="ta", away_team_id="tb", venue_id=venue_id,
                               starts_at="2026-05-23T14:00:00+10:00", round_label=fixture_id, season="2026", time_status="confirmed")

    def test_only_the_owning_club_can_share_or_unshare_a_venue(self):
        self.assertEqual(self.run_action("set_venue_shared", "mgr-b", venue_id="vc", org_id="b", shared=1).rowcount, 1)
        self.assertEqual(self.run_action("set_venue_shared", "conv-a", venue_id="vc", org_id="b", shared=0).rowcount, 0)
        self.assertEqual(self.run_action("set_venue_shared", "play-a", venue_id="vc", org_id="b", shared=0).rowcount, 0)
        self.assertEqual(self.db.execute("SELECT shared FROM venues WHERE id='vc'").fetchone()[0], 1)

    def test_another_clubs_shared_venue_can_host_fixtures_but_an_unshared_one_cannot(self):
        self.assertEqual(self.run_action("schedule_fixture", "conv-a", id="f-harbour", org_id="a", division_id="da", home_team_id="ta", away_team_id="tb",
                                         venue_id="vb", starts_at="2026-06-01T09:00:00+10:00", round_label="S1").rowcount, 1)
        self.assertEqual(self.run_action("schedule_fixture", "conv-a", id="f-private", org_id="a", division_id="da", home_team_id="ta", away_team_id="tb",
                                         venue_id="vc", starts_at="2026-06-02T09:00:00+10:00", round_label="S2").rowcount, 0)
        self.assertEqual(self.upsert("vb").rowcount, 1)
        self.assertEqual(self.upsert("vc", fixture_id="f-private-import").rowcount, 0)

    def test_a_club_using_a_shared_venue_cannot_edit_it(self):
        self.assertEqual(self.run_action("update_venue", "conv-a", venue_id="vb", org_id="b", name="Hijacked", address="", map_url="", notes="", convenor_phone="").rowcount, 0)
        self.assertEqual(self.db.execute("SELECT name FROM venues WHERE id='vb'").fetchone()[0], "Harbour Hall")

    def test_member_view_of_a_shared_venue_shows_travel_details_and_never_its_contacts(self):
        self.run_action("schedule_fixture", "conv-a", id="f-harbour", org_id="a", division_id="da", home_team_id="ta", away_team_id="tb",
                        venue_id="vb", starts_at="2026-06-01T09:00:00+10:00", round_label="S1")
        mine = {item["id"]: item for item in self.rows("list_my_fixtures", "play-a", **{"from": "2026-01-01"})}
        self.assertEqual((mine["f-harbour"]["venue_name"], mine["f-harbour"]["venue_address"], mine["f-harbour"]["venue_notes"]), ("Harbour Hall", "1 Pier Rd", "Park at the rear"))
        for item in mine.values():
            self.assertNotIn("convenor_phone", item)
            self.assertNotIn("0400 000 999", json.dumps(item))

    def test_import_options_list_shared_venues_of_other_clubs_but_not_their_unshared_ones(self):
        options = self.rows("list_fixture_import_options", "conv-a")
        venues = {item["name"]: item for item in options if item["kind"] == "venue"}
        self.assertEqual(venues["Harbour Hall"]["shared"], 1)
        self.assertNotIn("Private Courts", venues)
        self.assertNotIn("0400000999", json.dumps(options))
        self.assertNotIn("0400 000 999", json.dumps(options))

    def test_import_matching_prefers_the_clubs_own_venue_and_otherwise_needs_one_shared_match(self):
        self.assertEqual(self.validate([row(venue="Hall")]), [])
        self.assertEqual(self.validate([row(venue="Harbour Hall")]), [])
        self.assertIn((2, "blocking", "venue_not_found"), [(i["source_row"], i["severity"], i["code"]) for i in self.validate([row(venue="Private Courts")])])
        self.assertIn((2, "blocking", "venue_ambiguous"), [(i["source_row"], i["severity"], i["code"]) for i in self.validate([row(venue="Oval")])])

    def test_share_settings_are_visible_only_to_managers_of_the_owning_club(self):
        self.assertEqual(self.rows("list_club_venues", "play-a", org_id="b"), [])
        self.assertEqual(self.rows("list_club_venues", "conv-a", org_id="b"), [])
        shared = {item["name"]: item["shared"] for item in self.rows("list_club_venues", "mgr-b", org_id="b")}
        self.assertEqual((shared["Harbour Hall"], shared["Private Courts"]), (1, 0))


if __name__ == "__main__":
    unittest.main()

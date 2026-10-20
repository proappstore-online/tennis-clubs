import copy
import json
import sqlite3
import unittest
from pathlib import Path

from mcp_harness import connect

# Competition archive export and restore (issue #37). The restore test exports a seeded club, restores the archive into
# a fresh copy of the club, and checks the copy matches the original record for record.
ROOT = Path(__file__).resolve().parents[1]
MIGRATIONS = json.loads((ROOT / "migrations.json").read_text())["migrations"]
TOOLS = {tool["name"]: tool for tool in json.loads((ROOT / "mcp.json").read_text())["tools"]}

RESTORE_STEPS = [
    "restore_archive_seasons", "restore_archive_divisions", "restore_archive_venues", "restore_archive_external_clubs",
    "restore_archive_external_club_aliases", "restore_archive_teams", "restore_archive_team_players", "restore_archive_fixtures",
    "restore_archive_fixture_roster", "restore_archive_roster_players", "restore_archive_result_submissions",
]
SECTIONS = ["seasons", "divisions", "venues", "external_clubs", "external_club_aliases", "teams", "team_players", "fixtures",
            "fixture_roster", "roster_players", "fixture_result_submissions"]

CLUBS = """
INSERT INTO organizations(id,name,slug,created_at,created_by) VALUES ('a','Club A','club-a',1,'founder-a'),('b','Club B','club-b',1,'founder-b');
INSERT INTO club_memberships(id,org_id,user_id,role,display_name,is_active,created_at) VALUES
  ('m1','a','adm','admin','Admin A',1,1),
  ('m2','a','mgr','manager','Manager A',1,1),
  ('m3','a','play','player','Player A',1,1),
  ('m4','b','adm-b','admin','Admin B',1,1);
"""

# The source club: one of every record type, with the fields the archive must leave out.
SOURCE = CLUBS + """
INSERT INTO seasons(id,org_id,name,starts_on,ends_on,status,created_at) VALUES ('s1','a','2026','2026-03-01','2026-10-31','active',1);
INSERT INTO divisions(id,season_id,name,format,created_at) VALUES ('d1','s1','Division A','teams',1);
INSERT INTO venues(id,org_id,name,address,map_url,notes,convenor_phone,created_at,shared) VALUES ('v1','a','Central Courts','1 Court Rd','https://maps.example/central','Gate 2','0400 111 222',1,0);
INSERT INTO external_clubs(id,org_id,canonical_name,normalized_name,home_venue_id,created_at) VALUES ('ec1','a','Lakeside Club','lakeside club','v1',1);
INSERT INTO external_club_aliases(id,org_id,external_club_id,alias,normalized_alias,created_at) VALUES ('al1','a','ec1','LC','lc',1);
INSERT INTO teams(id,org_id,division_id,name,colour,created_at,external_club_id,is_external) VALUES ('t1','a','d1','Northside',NULL,1,NULL,0),('t2','a','d1','Lakeside Club',NULL,1,'ec1',1);
INSERT INTO team_players(team_id,user_id,display_name,is_active,pool,updated_at,updated_by) VALUES ('t1','p1','Sam Smith',1,'regular',1,'adm');
INSERT INTO fixtures(id,org_id,division_id,home_team_id,away_team_id,venue_id,starts_at,round_label,status,home_score,away_score,status_updated_at,match_notice,time_status,review_status,reviewed_by,reviewed_at,created_at,updated_at,source_row,source_date_raw,source_time_raw,source_import_run_id)
  VALUES ('f1','a','d1','t1','t2','v1','2026-03-07T14:00:00+11:00','R1','complete',3,5,1,'Call 0412 345 678','confirmed','approved','adm',1,1,1,4,'7/3/2026','14:00','imp-1');
INSERT INTO fixture_roster(fixture_id,user_id,display_name,availability,confirmed_at,selection,pool) VALUES ('f1','p1','Sam Smith','in',NULL,'selected','regular');
INSERT INTO roster_players(id,fixture_id,player_name,contact,availability,created_at) VALUES ('rp1','f1','Alex Lee','0400 999 888','in',1);
INSERT INTO fixture_result_submissions(id,fixture_id,submitted_by,home_score,away_score,set_results,scorecard_user_id,scorecard_path,submitted_at,correction_note) VALUES
  ('sub1','f1','mgr',2,5,'6-2,3-6,2-6',NULL,NULL,1,NULL),
  ('sub2','f1','mgr',3,5,'6-2,3-6,6-2','p1','fixture-cards/f1/scan.pdf',2,'Corrected third set');
INSERT INTO seasons(id,org_id,name,starts_on,ends_on,status,created_at) VALUES ('sb','b','2026','2026-03-01','2026-10-31','active',1);
INSERT INTO divisions(id,season_id,name,format,created_at) VALUES ('db','sb','Club B Division','teams',1);
INSERT INTO teams(id,org_id,division_id,name,colour,created_at,external_club_id,is_external) VALUES ('tb','b','db','Club B Team',NULL,1,NULL,0);
"""

# The restore target: the same club with its people and no competition records yet.
TARGET = CLUBS


def fresh_db(seed=""):
    db = connect()
    db.row_factory = sqlite3.Row
    for migration in MIGRATIONS:
        db.executescript(migration["sql"])
    if seed:
        db.executescript(seed)
    return db


class CompetitionArchiveTests(unittest.TestCase):
    def setUp(self):
        self.source = fresh_db(SOURCE)
        self.target = None

    def tearDown(self):
        self.source.close()
        if self.target is not None:
            self.target.close()

    def call(self, db, tool, user="mgr", org="a", **params):
        values = {"__user_id": user, "__now": 1000, "org_id": org, **params}
        return db.execute(TOOLS[tool]["sql"], values)

    def export(self, user="mgr", db=None):
        rows = self.call(db or self.source, "export_competition_archive", user=user).fetchall()
        return json.loads(rows[0]["archive"]) if rows else None

    def check(self, archive, user="mgr", org="a", db=None):
        rows = self.call(db or self.target, "import_competition_archive", user=user, org=org, archive=json.dumps(archive)).fetchall()
        return dict(rows[0]) if rows else None

    def restore(self, archive, user="mgr", org="a", db=None):
        """Runs every restore step in order and returns the rows each one wrote."""
        written = {}
        for step in RESTORE_STEPS:
            cursor = self.call(db or self.target, step, user=user, org=org, archive=json.dumps(archive))
            written[step] = cursor.rowcount
        return written

    def without_export_time(self, archive):
        return {key: value for key, value in archive.items() if key != "exported_at"}

    # Export

    def test_export_is_limited_to_managers_of_the_club(self):
        self.assertEqual(len(self.call(self.source, "export_competition_archive", user="play").fetchall()), 0)
        self.assertEqual(len(self.call(self.source, "export_competition_archive", user="adm-b").fetchall()), 0)
        self.assertEqual(len(self.call(self.source, "export_competition_archive", user="adm-b", org="a").fetchall()), 0)
        self.assertIsNotNone(self.export(user="mgr"))
        self.assertIsNotNone(self.export(user="adm"))

    def test_export_holds_every_record_and_names_stay_in_the_archive(self):
        archive = self.export()
        self.assertEqual(archive["format"], "tennis-clubs-competition-archive")
        self.assertEqual(archive["format_version"], 1)
        self.assertEqual(archive["organization"], {"id": "a", "name": "Club A", "slug": "club-a"})
        counts = {section: len(archive[section]) for section in SECTIONS}
        self.assertEqual(counts, {"seasons": 1, "divisions": 1, "venues": 1, "external_clubs": 1, "external_club_aliases": 1,
                                  "teams": 2, "team_players": 1, "fixtures": 1, "fixture_roster": 1, "roster_players": 1,
                                  "fixture_result_submissions": 2})
        self.assertEqual(archive["fixture_roster"][0]["display_name"], "Sam Smith")
        self.assertEqual(archive["roster_players"][0]["player_name"], "Alex Lee")
        self.assertEqual([row["set_results"] for row in archive["fixture_result_submissions"]], ["6-2,3-6,2-6", "6-2,3-6,6-2"])
        self.assertEqual(archive["fixture_result_submissions"][1]["correction_note"], "Corrected third set")

    def test_export_leaves_out_contact_details_scorecards_provenance_and_other_clubs(self):
        text = json.dumps(self.export())
        for secret in ["0400 111 222", "0400 999 888", "fixture-cards", "scorecard", "source_row", "imp-1", "7/3/2026",
                       "convenor_phone", "updated_by", "reviewed_by", "Club B", "Club B Team"]:
            self.assertNotIn(secret, text)
        fixture = self.export()["fixtures"][0]
        self.assertIsNone(fixture["match_notice"], "a notice holding a phone number is not exported")

    # Restore

    def test_restore_into_a_fresh_club_rebuilds_every_record_and_is_an_exact_copy(self):
        archive = self.export()
        self.target = fresh_db(TARGET)
        summary = self.check(archive)
        self.assertEqual(summary["valid"], 1)
        for section in SECTIONS:
            self.assertEqual(summary[f"{section}_in_archive"], len(archive[section]))
            self.assertEqual(summary[f"{section}_to_restore"], len(archive[section]), section)

        written = self.restore(archive)
        self.assertEqual(sum(written.values()), sum(len(archive[section]) for section in SECTIONS))
        self.assertEqual(list(written.values()), [len(archive[section]) for section in SECTIONS])

        after = self.check(archive)
        for section in SECTIONS:
            self.assertEqual(after[f"{section}_to_restore"], 0, section)

        restored = self.export(db=self.target)
        self.assertEqual(self.without_export_time(restored), self.without_export_time(archive))

    def test_player_names_and_results_are_preserved_on_restore(self):
        archive = self.export()
        self.target = fresh_db(TARGET)
        self.restore(archive)
        self.assertEqual(self.target.execute("SELECT display_name FROM fixture_roster WHERE fixture_id='f1'").fetchone()[0], "Sam Smith")
        self.assertEqual(self.target.execute("SELECT player_name FROM roster_players WHERE id='rp1'").fetchone()[0], "Alex Lee")
        self.assertEqual(self.target.execute("SELECT COUNT(*) FROM fixture_result_submissions WHERE fixture_id='f1'").fetchone()[0], 2)
        self.assertEqual(self.target.execute("SELECT home_score, away_score FROM fixtures WHERE id='f1'").fetchone()[0:2], (3, 5))

    def test_restoring_again_changes_nothing(self):
        archive = self.export()
        self.target = fresh_db(TARGET)
        self.restore(archive)
        again = self.restore(archive)
        self.assertEqual(sum(again.values()), 0)
        self.assertEqual(self.without_export_time(self.export(db=self.target)), self.without_export_time(archive))

    def test_restore_never_overwrites_a_record_that_still_exists(self):
        archive = self.export()
        self.target = fresh_db(TARGET)
        self.restore(archive)
        self.target.execute("UPDATE fixtures SET home_score=9, away_score=9 WHERE id='f1'")
        self.restore(archive)
        self.assertEqual(self.target.execute("SELECT home_score, away_score FROM fixtures WHERE id='f1'").fetchone()[0:2], (9, 9))

    def test_restore_is_refused_for_players_other_clubs_and_archives_of_another_club(self):
        archive = self.export()
        self.target = fresh_db(TARGET)
        self.assertEqual(sum(self.restore(archive, user="play").values()), 0)
        self.assertEqual(sum(self.restore(archive, user="adm-b", org="b").values()), 0)
        self.assertEqual(self.check(archive, org="b", user="adm-b")["valid"], 0)
        self.assertEqual(self.target.execute("SELECT COUNT(*) FROM seasons").fetchone()[0], 0)

    def test_a_record_whose_parent_is_missing_is_not_restored_and_is_reported(self):
        archive = self.export()
        broken = copy.deepcopy(archive)
        broken["teams"] = [team for team in broken["teams"] if team["id"] != "t2"]
        self.target = fresh_db(TARGET)
        self.restore(broken)
        self.assertEqual(self.target.execute("SELECT COUNT(*) FROM fixtures").fetchone()[0], 0)
        summary = self.check(broken)
        self.assertEqual(summary["fixtures_to_restore"], 1)
        self.assertEqual(summary["teams_to_restore"], 0)

    # Audit and run log

    def test_every_restore_step_is_an_audited_action(self):
        self.target = fresh_db(TARGET)
        for step in RESTORE_STEPS:
            with self.subTest(step=step):
                cursor = self.call(self.target, "record_audit_event", id=f"audit-{step}", action=step, target_type="competition_archive",
                                   target_id="a", outcome="succeeded")
                self.assertEqual(cursor.rowcount, 1)

    def test_archive_runs_are_recorded_and_the_direction_is_checked(self):
        self.call(self.source, "record_archive_run", direction="export", row_counts=json.dumps({"fixtures": 1}))
        self.assertEqual(self.source.execute("SELECT direction, row_counts FROM archive_run").fetchone()[0:2], ("export", '{"fixtures": 1}'))
        with self.assertRaises(sqlite3.IntegrityError):
            self.call(self.source, "record_archive_run", direction="delete", row_counts="{}")


if __name__ == "__main__":
    unittest.main()

import json
import sqlite3
import unittest
from pathlib import Path

from association_seed import seed_association
from mcp_harness import connect

# Recovery rehearsal (issue #30): export a club from a copy of the association, restore the archive into an empty copy
# of that club, and check the restored data matches the original. The association is the synthetic seed of #35, so
# this rehearses the procedure at association scale without touching live data.
ROOT = Path(__file__).resolve().parents[1]
MIGRATIONS = json.loads((ROOT / "migrations.json").read_text())["migrations"]
TOOLS = {tool["name"]: tool for tool in json.loads((ROOT / "mcp.json").read_text())["tools"]}

CLUB = "club-000"
ADMIN = "club-000-admin"
RESTORE_STEPS = [
    "restore_archive_seasons", "restore_archive_divisions", "restore_archive_venues", "restore_archive_external_clubs",
    "restore_archive_external_club_aliases", "restore_archive_teams", "restore_archive_team_players", "restore_archive_fixtures",
    "restore_archive_fixture_roster", "restore_archive_roster_players", "restore_archive_result_submissions",
]
SECTIONS = ["seasons", "divisions", "venues", "external_clubs", "external_club_aliases", "teams", "team_players", "fixtures",
            "fixture_roster", "roster_players", "fixture_result_submissions"]
# The tables the rehearsal compares directly, row for row, for the club.
CLUB_ROWS = {
    "seasons": "SELECT id,org_id,name,starts_on,ends_on,status FROM seasons WHERE org_id=? ORDER BY id",
    "fixtures": "SELECT id,home_team_id,away_team_id,starts_at,status,home_score,away_score FROM fixtures WHERE org_id=? ORDER BY id",
    "teams": "SELECT id,name,division_id,is_external FROM teams WHERE org_id=? ORDER BY id",
    "fixture_roster": "SELECT fr.fixture_id,fr.user_id,fr.display_name,fr.availability,fr.selection FROM fixture_roster fr JOIN fixtures f ON f.id=fr.fixture_id WHERE f.org_id=? ORDER BY fr.fixture_id,fr.user_id",
}


def fresh_db():
    db = connect()
    db.row_factory = sqlite3.Row
    for migration in MIGRATIONS:
        db.executescript(migration["sql"])
    return db


class RecoveryRehearsalTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.source = fresh_db()
        cls.counts = seed_association(cls.source)
        cls.archive_row = cls.source.execute(TOOLS["export_competition_archive"]["sql"], {"__user_id": ADMIN, "__now": 1000, "org_id": CLUB}).fetchall()
        cls.archive = json.loads(cls.archive_row[0]["archive"])
        cls.target = fresh_db()
        org = cls.source.execute("SELECT id,name,slug,created_at FROM organizations WHERE id=?", (CLUB,)).fetchone()
        cls.target.execute("INSERT INTO organizations(id,name,slug,created_at,created_by) VALUES (?,?,?,?,?)", (org["id"], org["name"], org["slug"], org["created_at"], "seed"))
        cls.target.execute("INSERT INTO club_memberships(id,org_id,user_id,role,display_name,is_active,created_at) VALUES (?,?,?,?,?,1,1)", ("rehearse-admin", CLUB, ADMIN, "admin", "Admin"))
        cls.summary = dict(cls.target.execute(TOOLS["import_competition_archive"]["sql"], {"__user_id": ADMIN, "__now": 1000, "org_id": CLUB, "archive": json.dumps(cls.archive)}).fetchone())
        cls.written = {}
        for step in RESTORE_STEPS:
            cls.written[step] = cls.target.execute(TOOLS[step]["sql"], {"__user_id": ADMIN, "__now": 1000, "org_id": CLUB, "archive": json.dumps(cls.archive)}).rowcount
        cls.after = dict(cls.target.execute(TOOLS["import_competition_archive"]["sql"], {"__user_id": ADMIN, "__now": 1000, "org_id": CLUB, "archive": json.dumps(cls.archive)}).fetchone())
        cls.rerun = sum(cls.target.execute(TOOLS[step]["sql"], {"__user_id": ADMIN, "__now": 1000, "org_id": CLUB, "archive": json.dumps(cls.archive)}).rowcount for step in RESTORE_STEPS)

    @classmethod
    def tearDownClass(cls):
        cls.source.close()
        cls.target.close()

    def rows(self, db, sql):
        return [tuple(row) for row in db.execute(sql, (CLUB,)).fetchall()]

    def test_the_archive_holds_every_record_of_the_club_at_association_scale(self):
        self.assertEqual(self.archive["format_version"], 1)
        self.assertEqual(self.archive["organization"]["id"], CLUB)
        self.assertEqual(len(self.archive["fixtures"]), len(self.rows(self.source, CLUB_ROWS["fixtures"])))
        self.assertGreater(len(self.archive["fixtures"]), 300)

    def test_every_section_is_counted_before_the_restore(self):
        for section in SECTIONS:
            with self.subTest(section=section):
                self.assertEqual(self.summary[f"{section}_in_archive"], len(self.archive[section]))
                self.assertEqual(self.summary[f"{section}_to_restore"], len(self.archive[section]))
        self.assertEqual(self.summary["valid"], 1)

    def test_the_restore_writes_exactly_what_the_archive_holds(self):
        self.assertEqual(list(self.written.values()), [len(self.archive[section]) for section in SECTIONS])

    def test_after_the_restore_nothing_is_missing_and_a_second_restore_writes_nothing(self):
        for section in SECTIONS:
            with self.subTest(section=section):
                self.assertEqual(self.after[f"{section}_to_restore"], 0)
        self.assertEqual(self.rerun, 0)

    def test_the_restored_club_matches_the_original_row_for_row(self):
        for name, sql in CLUB_ROWS.items():
            with self.subTest(table=name):
                self.assertEqual(self.rows(self.target, sql), self.rows(self.source, sql))

    def test_the_restored_club_exports_the_same_archive(self):
        again = json.loads(self.target.execute(TOOLS["export_competition_archive"]["sql"], {"__user_id": ADMIN, "__now": 1000, "org_id": CLUB}).fetchone()["archive"])
        for section in ["organization"] + SECTIONS:
            with self.subTest(section=section):
                self.assertEqual(again[section], self.archive[section])

    def test_player_names_and_results_survive_the_restore(self):
        original = self.rows(self.source, CLUB_ROWS["fixture_roster"])
        restored = self.rows(self.target, CLUB_ROWS["fixture_roster"])
        self.assertGreater(len(restored), 0)
        self.assertEqual(restored, original)
        self.assertEqual(self.target.execute("SELECT COUNT(*) FROM fixture_result_submissions").fetchone()[0],
                         self.source.execute("SELECT COUNT(*) FROM fixture_result_submissions WHERE fixture_id IN (SELECT id FROM fixtures WHERE org_id=?)", (CLUB,)).fetchone()[0])

    def test_another_club_is_not_restored_into_this_one(self):
        other = self.source.execute("SELECT id FROM organizations WHERE id<>? LIMIT 1", (CLUB,)).fetchone()[0]
        foreign = self.source.execute(TOOLS["export_competition_archive"]["sql"], {"__user_id": "club-001-admin", "__now": 1000, "org_id": other}).fetchone()
        self.assertIsNotNone(foreign)
        check = dict(self.target.execute(TOOLS["import_competition_archive"]["sql"], {"__user_id": ADMIN, "__now": 1000, "org_id": CLUB, "archive": foreign["archive"]}).fetchone())
        self.assertEqual(check["valid"], 0)


if __name__ == "__main__":
    unittest.main()

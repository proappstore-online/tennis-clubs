import json
import re
import sqlite3
import unittest
from pathlib import Path

from mcp_harness import connect

# Column classification for the whole schema (issue #29). docs/data-classification.json is the map; this test keeps
# it equal to the migrated schema, so a new column cannot ship unclassified, and checks the rules the classes carry.
ROOT = Path(__file__).resolve().parents[1]
MIGRATIONS = json.loads((ROOT / "migrations.json").read_text())["migrations"]
MAP = json.loads((ROOT / "docs" / "data-classification.json").read_text())
CLASSES = MAP["classes"]
TABLES = MAP["tables"]
DOC = (ROOT / "docs" / "privacy-data-classification.md").read_text(encoding="utf-8")

# Reserved classes: no column may use them until a retention rule and a consent or minimisation decision exist.
RESERVED = {"junior", "location"}
RESERVED_NAMES = re.compile(r"birth|dob|(^|_)age($|_)|junior|minor|guardian|latitude|longitude|(^|_)lat($|_)|(^|_)lng($|_)|geo|location|postcode|home_address", re.I)
# Names that identify a person or hold free text about one. A column matching this is never public unless listed below.
PERSONAL_NAMES = re.compile(r"name|phone|email|contact|display|player|user|actor|by$|note|message|remediation|source_key|token|invite", re.I)
# Public by policy: club, team, season, division and venue names, and the venue access notes the club publishes.
PUBLIC_NAME_EXCEPTIONS = {
    ("organizations", "name"): "the club's own name",
    ("seasons", "name"): "the season's name",
    ("divisions", "name"): "the division's name",
    ("teams", "name"): "the team's name",
    ("venues", "name"): "the venue's public name",
    ("venues", "notes"): "venue access notes; the import blocks contact details in them",
    ("external_clubs", "canonical_name"): "an opponent club's name",
    ("external_clubs", "normalized_name"): "a normalised opponent club name",
}


def schema_columns(db):
    columns = {}
    for (table,) in db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"):
        columns[table] = [row[1] for row in db.execute(f"PRAGMA table_info({table})")]
    return columns


class DataClassificationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.db = connect()
        for migration in MIGRATIONS:
            cls.db.executescript(migration["sql"])
        cls.columns = schema_columns(cls.db)

    @classmethod
    def tearDownClass(cls):
        cls.db.close()

    def test_every_table_and_column_in_the_schema_is_classified(self):
        self.assertEqual(sorted(self.columns), sorted(TABLES), "every table must be classified, and no table may be stale")
        for table, columns in self.columns.items():
            with self.subTest(table=table):
                self.assertEqual(sorted(columns), sorted(TABLES[table]), "every column must be classified, and no column may be stale")

    def test_every_class_used_is_defined_and_has_a_retention_rule(self):
        used = {klass for columns in TABLES.values() for klass in columns.values()}
        self.assertLessEqual(used, set(CLASSES))
        for klass, spec in CLASSES.items():
            with self.subTest(klass=klass):
                self.assertTrue(spec["meaning"].strip())
                self.assertTrue(spec["retention"].strip())

    def test_reserved_classes_have_no_columns_and_no_column_suggests_them(self):
        for table, columns in TABLES.items():
            for column, klass in columns.items():
                with self.subTest(table=table, column=column):
                    self.assertNotIn(klass, RESERVED)
                    self.assertIsNone(RESERVED_NAMES.search(column), "a column that suggests junior or location data needs a decision first")

    def test_person_identifying_columns_are_never_public_unless_excepted(self):
        for table, columns in TABLES.items():
            for column, klass in columns.items():
                if PERSONAL_NAMES.search(column) and klass == "public":
                    with self.subTest(table=table, column=column):
                        self.assertIn((table, column), PUBLIC_NAME_EXCEPTIONS)

    def test_contact_columns_are_only_where_contact_details_are_stored(self):
        contact = sorted(f"{table}.{column}" for table, columns in TABLES.items() for column, klass in columns.items() if klass == "contact")
        self.assertEqual(contact, sorted(["contact_details.kind", "contact_details.label", "contact_details.value", "roster_players.contact", "venues.convenor_phone"]))

    def test_the_roster_contact_column_is_only_ever_written_as_null(self):
        writers = []
        for tool in json.loads((ROOT / "mcp.json").read_text())["tools"]:
            match = re.search(r"INSERT INTO roster_players \(([^)]*)\)", tool["sql"])
            if match and "contact" in match.group(1):
                writers.append(tool["name"])
        self.assertEqual(writers, ["apply_draw_roster"])
        apply_roster = next(tool for tool in json.loads((ROOT / "mcp.json").read_text())["tools"] if tool["name"] == "apply_draw_roster")
        self.assertIn("x.fixture_id,x.name,NULL,'pending'", apply_roster["sql"])

    def test_scorecard_columns_are_only_on_result_submissions(self):
        scorecard = sorted(f"{table}.{column}" for table, columns in TABLES.items() for column, klass in columns.items() if klass == "scorecard")
        self.assertEqual(scorecard, ["fixture_result_submissions.scorecard_path", "fixture_result_submissions.scorecard_user_id"])

    def test_the_privacy_document_describes_every_class_in_use(self):
        for klass in CLASSES:
            with self.subTest(klass=klass):
                self.assertIn(f"`{klass}`", DOC)


if __name__ == "__main__":
    unittest.main()

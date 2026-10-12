"""Regression coverage for the Comps fixture and roster import paths."""

import json
import os
import subprocess
import unittest
from pathlib import Path

from mcp_harness import connect


ROOT = Path(__file__).resolve().parents[1]
IMPORT_LOGIC = ROOT / "web/src/pages/fixtureImportLogic.ts"
IMPORT_COMPONENT = ROOT / "web/src/pages/FixtureImport.tsx"

OPTIONS = [
    {"kind": "team", "id": "team-home", "name": "Northside", "org_id": "club-1", "division_id": "div-1", "season_name": "2026"},
    {"kind": "team", "id": "team-away", "name": "Lakeside", "org_id": "club-1", "division_id": "div-1", "season_name": "2026"},
    {"kind": "venue", "id": "venue-1", "name": "Central Courts", "org_id": "club-1"},
]


def run_import_logic(csv_text, options=OPTIONS):
    """Call the same TypeScript parser and row mapper used by FixtureImport."""
    script = r"""
      const { parseCsv, mapFixtureRows } = await import(`file://${process.env.IMPORT_LOGIC}`);
      let input = '';
      for await (const chunk of process.stdin) input += chunk;
      const { csv, options } = JSON.parse(input);
      process.stdout.write(JSON.stringify(mapFixtureRows(parseCsv(csv), options)));
    """
    result = subprocess.run(
        ["node", "--experimental-strip-types", "--input-type=module", "-e", script],
        cwd=ROOT,
        env={**os.environ, "IMPORT_LOGIC": str(IMPORT_LOGIC)},
        input=json.dumps({"csv": csv_text, "options": options}),
        text=True,
        capture_output=True,
        check=True,
    )
    return json.loads(result.stdout)


class FixtureRosterImportTests(unittest.TestCase):
    def test_fixture_import_uses_melbourne_daylight_saving_offset(self):
        script = r"""
          const { melbourneFixtureStart } = await import(`file://${process.env.IMPORT_LOGIC}`);
          process.stdout.write(JSON.stringify([
            melbourneFixtureStart('2026-06-11'),
            melbourneFixtureStart('2026-10-11'),
          ]));
        """
        result = subprocess.run(
            ["node", "--experimental-strip-types", "--input-type=module", "-e", script],
            cwd=ROOT,
            env={**os.environ, "IMPORT_LOGIC": str(IMPORT_LOGIC)},
            text=True,
            capture_output=True,
            check=True,
        )
        self.assertEqual(json.loads(result.stdout), [
            "2026-06-11T09:00:00+10:00",
            "2026-10-11T09:00:00+11:00",
        ])
        self.assertNotIn("T09:00:00+10:00", IMPORT_COMPONENT.read_text())

    def test_fixture_csv_columns_are_mapped_to_preview_and_team_ids(self):
        rows = run_import_logic(
            "date,round,opponent,home_away,venue,team,season\n"
            "2026-05-02,Round 1,Lakeside,home,Central Courts,Northside,2026\n"
        )

        row = rows[0]
        self.assertEqual({key: row[key] for key in ("date", "round", "opponent", "home_away", "venue", "team")}, {
            "date": "2026-05-02",
            "round": "Round 1",
            "opponent": "Lakeside",
            "home_away": "home",
            "venue": "Central Courts",
            "team": "Northside",
        })
        self.assertEqual(row["home_team_id"], "team-home")
        self.assertEqual(row["away_team_id"], "team-away")
        self.assertEqual(row["venue_id"], "venue-1")
        self.assertEqual(row["issue"], "")


    def test_invalid_date_missing_team_and_unmatched_venue_are_flagged(self):
        cases = [
            ("date,round,opponent,home_away,venue,team,season\n2026-02-30,R1,Lakeside,home,Central Courts,Northside,2026\n", "invalid date"),
            ("date,round,opponent,home_away,venue,team,season\n2026-05-02,R1,Lakeside,home,Central Courts,,2026\n", "missing team"),
            ("date,round,opponent,home_away,venue,team,season\n2026-05-02,R1,Lakeside,home,Unknown Courts,Northside,2026\n", "venue not found"),
            ("date,round,opponent,home_away,venue,team,season\n2026-05-02,R1,Nobody FC,home,Central Courts,Northside,2026\n", "opponent team not found"),
        ]
        for csv_text, expected_issue in cases:
            with self.subTest(expected_issue=expected_issue):
                row = run_import_logic(csv_text)[0]
                self.assertIn(expected_issue, row["issue"])

        # The component disables save for mapped fixture issues and rechecks inside save().
        component = IMPORT_COMPONENT.read_text()
        self.assertIn("fixtures.some((row) => row.issue)", component)
        self.assertIn("if (row.issue) throw new Error('Fix all fixture validation errors before saving.')", component)


    def test_fixture_action_natural_key_updates_existing_fixture_on_reimport(self):
        """Run the actual migration and MCP action SQL with synthetic SQLite data."""
        import sqlite3

        migrations = json.loads((ROOT / "migrations.json").read_text())["migrations"]
        actions = json.loads((ROOT / "mcp.json").read_text())["tools"]
        fixture_action = next(item for item in actions if item["name"] == "upsert_imported_fixture")
        conn = connect()
        conn.row_factory = sqlite3.Row
        for migration in migrations:
            conn.executescript(migration["sql"])

        conn.execute("INSERT INTO organizations (id,name,slug,created_at) VALUES ('club-1','Club','club',1)")
        conn.execute("INSERT INTO club_memberships (id,org_id,user_id,role,display_name,is_active,created_at) VALUES ('m1','club-1','manager-1','manager','Manager',1,1)")
        conn.execute("INSERT INTO seasons (id,org_id,name,starts_on,ends_on,created_at) VALUES ('season-1','club-1','2026','2026-01-01','2026-12-31',1)")
        conn.execute("INSERT INTO divisions (id,season_id,name,created_at) VALUES ('div-1','season-1','A',1)")
        conn.execute("INSERT INTO teams (id,org_id,division_id,name,created_at) VALUES ('home','club-1','div-1','Northside',1),('away','club-1','div-1','Lakeside',1)")
        conn.execute("INSERT INTO venues (id,org_id,name,created_at) VALUES ('venue-1','club-1','Central Courts',1),('venue-2','club-1','Reserve Courts',1)")

        params = {
            "org_id": "club-1", "home_team_id": "home", "away_team_id": "away",
            "starts_at": "2026-05-02T09:00:00+10:00", "round_label": "Round 1",
            "season": "2026", "__user_id": "manager-1", "__now": 100,
            "venue_id": "venue-1", "id": "first-random-id",
        }
        conn.execute(fixture_action["sql"], params)
        params.update({"venue_id": "venue-2", "id": "second-random-id", "__now": 200})
        conn.execute(fixture_action["sql"], params)

        fixtures = conn.execute("SELECT id, venue_id FROM fixtures").fetchall()
        self.assertEqual(len(fixtures), 1)
        self.assertEqual(fixtures[0]["id"], "first-random-id")
        self.assertEqual(fixtures[0]["venue_id"], "venue-2")

        # The SQL action must fail closed even if a caller bypasses the CSV preview validation.
        params.update({"id": "bad-date", "starts_at": "next Sunday sometime"})
        conn.execute(fixture_action["sql"], params)
        self.assertEqual(conn.execute("SELECT COUNT(*) FROM fixtures").fetchone()[0], 1)


    def test_roster_preview_does_not_render_player_names_or_contact_details(self):
        """Protect the actual preview markup from exposing roster PII."""
        component = IMPORT_COMPONENT.read_text()
        preview_start = component.index("{roster.length > 0 &&")
        preview_end = component.index("<button disabled={busy || invalid}", preview_start)
        preview = component[preview_start:preview_end]

        self.assertIn("roster.length", preview)
        self.assertIn("Names and contact details are hidden from this preview.", preview)
        self.assertNotIn("row.player_name", preview)
        self.assertNotIn("row.contact", preview)
        self.assertNotIn("roster.map", preview)

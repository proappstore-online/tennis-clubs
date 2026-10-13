import json
import os
import sqlite3
import subprocess
import unittest
from pathlib import Path

from mcp_harness import connect

ROOT = Path(__file__).resolve().parents[1]
MIGRATIONS = json.loads((ROOT / "migrations.json").read_text())["migrations"]
TOOLS = {tool["name"]: tool for tool in json.loads((ROOT / "mcp.json").read_text())["tools"]}
IMPORT_LOGIC = ROOT / "web/src/pages/fixtureImportLogic.ts"

SEED = """
INSERT INTO organizations(id,name,slug,created_at,created_by) VALUES ('a','Club A','club-a',1,'founder-a'),('b','Club B','club-b',1,'founder-b');
INSERT INTO club_memberships(id,org_id,user_id,role,display_name,is_active,created_at) VALUES
  ('m1','a','conv-a','convenor','Convenor A',1,1),
  ('m2','a','play-a','player','Player A',1,1),
  ('m3','b','mgr-b','manager','Manager B',1,1);
INSERT INTO seasons(id,org_id,name,starts_on,ends_on,status,created_at) VALUES ('sa','a','2026','2026-01-01','2026-12-31','upcoming',1);
INSERT INTO divisions(id,season_id,name,format,created_at) VALUES ('da','sa','Div A',NULL,1);
INSERT INTO teams(id,org_id,division_id,name,colour,created_at,is_external) VALUES
  ('ta','a','da','Northside',NULL,1,0),('tb','a','da','Lakeside',NULL,1,0);
INSERT INTO external_clubs(id,org_id,canonical_name,normalized_name,created_at) VALUES ('ec-r','a','Rival Club','rival club',1);
INSERT INTO external_club_aliases(id,org_id,external_club_id,alias,normalized_alias,created_at) VALUES ('al-r','a','ec-r','RC','rc',1);
INSERT INTO teams(id,org_id,division_id,name,colour,created_at,external_club_id,is_external) VALUES ('tx-r','a',NULL,'Rival Club',NULL,1,'ec-r',1);
INSERT INTO venues(id,org_id,name,address,map_url,notes,convenor_phone,created_at) VALUES ('va','a','Central Courts',NULL,NULL,NULL,'0400000001',1);
INSERT INTO team_memberships(id,org_id,team_id,user_id,display_name,invite_token,created_by,accepted_at,created_at) VALUES ('tm1','a','ta','play-a','Player A',NULL,'conv-a',1,1);
INSERT INTO fixtures(id,org_id,division_id,home_team_id,away_team_id,venue_id,starts_at,round_label,status,created_at,time_status) VALUES
  ('f-exist','a','da','ta','tb','va','2026-05-02T14:00:00+10:00','R1','scheduled',1,'confirmed');
"""

CLEAN = {"source_row": 2, "date": "2026-05-09", "start_time": "14:00", "arrival_time": "", "time_status": "", "timezone": "",
         "round": "R2", "opponent": "Lakeside", "home_away": "home", "venue": "Central Courts", "team": "Northside", "season": "2026"}


def row(**changes):
    return {**CLEAN, **changes}


class FixtureTimingTests(unittest.TestCase):
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

    def validate(self, rows, user="conv-a"):
        return [dict(issue) for issue in self.run_action("validate_fixture_import", user, org_id="a", rows=json.dumps(rows)).fetchall()]

    def codes(self, rows, user="conv-a"):
        return sorted((issue["source_row"], issue["severity"], issue["code"]) for issue in self.validate(rows, user))

    def test_client_timing_never_invents_a_confirmed_start(self):
        script = r"""
          const { fixtureTiming } = await import(`file://${process.env.IMPORT_LOGIC}`);
          process.stdout.write(JSON.stringify([
            fixtureTiming({ date: '2026-05-16', start_time: '', arrival_time: '08:30', time_status: '' }),
            fixtureTiming({ date: '2026-05-16', start_time: '15:00', arrival_time: '', time_status: '' }),
            fixtureTiming({ date: '2026-05-16', start_time: '', arrival_time: '', time_status: 'estimated' }),
          ]));
        """
        result = subprocess.run(["node", "--experimental-strip-types", "--input-type=module", "-e", script], cwd=ROOT,
                                env={**os.environ, "IMPORT_LOGIC": str(IMPORT_LOGIC)}, text=True, capture_output=True, check=True)
        without_start, with_start, estimate_without_start = json.loads(result.stdout)
        self.assertEqual(without_start, {"timing_status": "tbc", "starts_at": "2026-05-16T00:00:00+10:00", "arrival_at": "2026-05-16T08:30:00+10:00"})
        self.assertEqual(with_start, {"timing_status": "confirmed", "starts_at": "2026-05-16T15:00:00+10:00", "arrival_at": None})
        self.assertEqual(estimate_without_start["timing_status"], "tbc")

    def test_clean_rows_have_no_issues(self):
        self.assertEqual(self.validate([CLEAN]), [])

    def test_invalid_and_mixed_dates_are_flagged(self):
        self.assertEqual(self.codes([row(source_row=2, date="2026-02-30"), row(source_row=3, date="9/5/2026")]),
                         [(2, "blocking", "invalid_date"), (3, "blocking", "invalid_date")])
        mixed = self.codes([row(source_row=2, date="2026-05-09"), row(source_row=3, date="16/05/2026", round="R3")])
        self.assertIn((2, "warning", "mixed_date_format"), mixed)
        self.assertIn((3, "warning", "mixed_date_format"), mixed)
        self.assertNotIn("invalid_date", [code for _, _, code in mixed])

    def test_missing_start_time_is_a_tbc_warning_and_arrival_needs_a_confirmed_start(self):
        codes = self.codes([row(start_time="", arrival_time="08:30")])
        self.assertEqual(codes, [(2, "warning", "arrival_without_start"), (2, "warning", "start_time_missing")])

    def test_time_status_timezone_and_start_format_are_validated(self):
        self.assertIn((2, "blocking", "invalid_time_status"), self.codes([row(time_status="maybe")]))
        self.assertIn((2, "blocking", "confirmed_without_start"), self.codes([row(time_status="confirmed", start_time="")]))
        self.assertIn((2, "blocking", "timezone_mismatch"), self.codes([row(timezone="Australia/Sydney")]))
        self.assertIn((2, "blocking", "invalid_time"), self.codes([row(start_time="25:00")]))
        self.assertIn((2, "warning", "estimated_time"), self.codes([row(time_status="estimated")]))
        self.assertEqual(self.validate([row(timezone="Australia/Melbourne")]), [])

    def test_unknown_names_and_missing_identity_fields_block(self):
        self.assertIn((2, "blocking", "team_not_found"), self.codes([row(team="Nowhere")]))
        self.assertIn((2, "blocking", "opponent_not_found"), self.codes([row(opponent="Ghost FC")]))
        self.assertIn((2, "blocking", "venue_not_found"), self.codes([row(venue="Mars")]))
        self.assertIn((2, "blocking", "invalid_home_away"), self.codes([row(home_away="middle")]))
        self.assertIn((2, "blocking", "missing_round"), self.codes([row(round="")]))
        self.assertIn((2, "blocking", "season_mismatch"), self.codes([row(season="2027")]))

    def test_external_alias_is_matched_and_not_flagged(self):
        self.assertEqual(self.validate([row(opponent=" rc ", home_away="home"), row(source_row=3, opponent="Rival  Club", round="R3")]), [])

    def test_ambiguous_venue_blocks(self):
        self.db.execute("INSERT INTO venues(id,org_id,name,address,map_url,notes,convenor_phone,created_at) VALUES ('vb','a','central courts',NULL,NULL,NULL,NULL,1)")
        self.assertIn((2, "blocking", "venue_ambiguous"), self.codes([row()]))

    def test_conflicting_rows_for_one_fixture_block_and_duplicates_warn(self):
        conflicts = self.codes([row(source_row=2, date="2026-05-09"), row(source_row=3, date="2026-05-16")])
        self.assertIn((2, "blocking", "conflicting_date"), conflicts)
        self.assertIn((3, "blocking", "conflicting_date"), conflicts)
        venue = self.codes([row(source_row=2), row(source_row=3, venue="Other Venue")])
        self.assertIn((3, "blocking", "conflicting_venue"), venue)
        duplicate = self.codes([row(source_row=2), row(source_row=3)])
        self.assertEqual(duplicate, [(3, "warning", "duplicate_row")])

    def test_source_time_downgrade_and_change_are_checked_against_stored_fixture(self):
        same_day = "2026-05-02"
        base = row(date=same_day, round="R1", start_time="", home_away="home", team="Northside", opponent="Lakeside")
        self.assertIn((2, "warning", "time_downgrade"), self.codes([base]))
        changed = row(date=same_day, round="R1", start_time="15:00", time_status="confirmed", team="Northside", opponent="Lakeside")
        self.assertIn((2, "warning", "time_change"), self.codes([changed]))
        unchanged = row(date=same_day, round="R1", start_time="14:00", team="Northside", opponent="Lakeside")
        self.assertEqual(self.validate([unchanged]), [])

    def test_dry_run_is_manager_only_and_writes_nothing(self):
        bad = [row(date="2026-02-30")]
        self.assertEqual(self.validate(bad, user="play-a"), [])
        self.assertEqual(self.validate(bad, user="mgr-b"), [])
        self.assertEqual(len(self.validate(bad, user="conv-a")), 1)
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM fixtures").fetchone()[0], 1)

    def upsert(self, **values):
        base = {"id": "f-new", "org_id": "a", "home_team_id": "ta", "away_team_id": "tb", "venue_id": "va",
                "starts_at": "2026-05-16T00:00:00+10:00", "round_label": "R3", "season": "2026", "warning_codes": "[]"}
        return self.run_action("upsert_imported_fixture", "conv-a", **{**base, **values})

    def test_import_stores_time_status_arrival_and_provenance_and_players_see_only_timing(self):
        self.assertEqual(self.upsert(time_status="tbc", arrival_at="2026-05-16T08:30:00+10:00", source_row=4, source_date_raw="16/05/2026", source_time_raw="", import_run_id="run-1").rowcount, 1)
        stored = dict(self.db.execute("SELECT time_status,arrival_at,source_row,source_date_raw,source_time_raw FROM fixtures WHERE id='f-new'").fetchone())
        self.assertEqual(stored, {"time_status": "tbc", "arrival_at": "2026-05-16T08:30:00+10:00", "source_row": 4, "source_date_raw": "16/05/2026", "source_time_raw": ""})
        manager_view = self.run_action("list_managed_fixtures", "conv-a", **{"from": "2026-01-01"}).fetchall()
        managed = {row["id"]: dict(row) for row in manager_view}["f-new"]
        self.assertEqual((managed["time_status"], managed["source_row"]), ("tbc", 4))
        player_view = {row["id"]: dict(row) for row in self.run_action("list_my_fixtures", "play-a", **{"from": "2026-01-01"}).fetchall()}
        self.assertIn("f-exist", player_view)
        self.assertEqual(player_view["f-exist"]["time_status"], "confirmed")
        self.assertNotIn("source_row", player_view["f-exist"])

    def test_a_tbc_import_never_duplicates_or_downgrades_a_confirmed_fixture(self):
        self.assertEqual(self.upsert(id="f-dup", starts_at="2026-05-02T00:00:00+10:00", round_label="R1", home_team_id="ta", away_team_id="tb", time_status="tbc").rowcount, 0)
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM fixtures").fetchone()[0], 1)
        reconciled = self.run_action("reconcile_imported_fixture_time", "conv-a", org_id="a", round_label="R1", home_team_id="ta", away_team_id="tb", starts_at="2026-05-02T00:00:00+10:00", time_status="tbc")
        self.assertEqual(reconciled.rowcount, 0)
        self.assertEqual(self.db.execute("SELECT starts_at,time_status FROM fixtures WHERE id='f-exist'").fetchone()[0:2], ("2026-05-02T14:00:00+10:00", "confirmed"))

    def test_a_later_source_can_confirm_a_tbc_time_without_duplicating(self):
        self.upsert(time_status="tbc", starts_at="2026-05-16T00:00:00+10:00")
        reconciled = self.run_action("reconcile_imported_fixture_time", "conv-a", org_id="a", round_label="R3", home_team_id="ta", away_team_id="tb", starts_at="2026-05-16T15:00:00+10:00", time_status="confirmed", source_row=5, import_run_id="run-2")
        self.assertEqual(reconciled.rowcount, 1)
        self.upsert(time_status="confirmed", starts_at="2026-05-16T15:00:00+10:00")
        rows = self.db.execute("SELECT starts_at,time_status,source_row FROM fixtures WHERE round_label='R3'").fetchall()
        self.assertEqual([tuple(r) for r in rows], [("2026-05-16T15:00:00+10:00", "confirmed", 5)])

    def test_each_declared_warning_code_needs_its_own_acceptance_for_its_row(self):
        codes = json.dumps(["start_time_missing"])
        self.assertEqual(self.upsert(source_row=2, warning_codes=codes, import_run_id="run-3").rowcount, 0)
        self.assertEqual(self.run_action("record_fixture_import_resolution", "conv-a", id="res-1", org_id="a", import_run_id="run-3", code="start_time_missing", source_row=2).rowcount, 1)
        self.assertEqual(self.run_action("record_fixture_import_resolution", "conv-a", id="res-2", org_id="a", import_run_id="run-3", code="start_time_missing", source_row=2).rowcount, 0)
        self.assertEqual(self.upsert(source_row=2, warning_codes=codes, import_run_id="run-3").rowcount, 1)
        self.assertEqual(self.run_action("record_fixture_import_resolution", "conv-a", id="res-3", org_id="a", import_run_id="run-3", code="team_not_found", source_row=2).rowcount, 0)
        self.assertEqual(self.run_action("record_fixture_import_resolution", "play-a", id="res-4", org_id="a", import_run_id="run-3", code="start_time_missing", source_row=2).rowcount, 0)

    def test_a_row_with_an_unaccepted_warning_code_is_refused(self):
        codes = json.dumps(["estimated_time", "start_time_missing"])
        self.run_action("record_fixture_import_resolution", "conv-a", id="res-p1", org_id="a", import_run_id="run-4", code="estimated_time", source_row=3)
        self.assertEqual(self.upsert(id="f-partial", round_label="R4", source_row=3, warning_codes=codes, import_run_id="run-4").rowcount, 0)
        self.run_action("record_fixture_import_resolution", "conv-a", id="res-p2", org_id="a", import_run_id="run-4", code="start_time_missing", source_row=3)
        self.assertEqual(self.upsert(id="f-partial", round_label="R4", source_row=3, warning_codes=codes, import_run_id="run-4").rowcount, 1)

    def test_one_acceptance_does_not_unlock_other_rows_codes_or_runs(self):
        self.run_action("record_fixture_import_resolution", "conv-a", id="res-r1", org_id="a", import_run_id="run-5", code="start_time_missing", source_row=2)
        other_row = self.upsert(id="f-row3", round_label="R5", source_row=3, warning_codes=json.dumps(["start_time_missing"]), import_run_id="run-5")
        self.assertEqual(other_row.rowcount, 0)
        other_code = self.upsert(id="f-row2b", round_label="R6", source_row=2, warning_codes=json.dumps(["estimated_time"]), import_run_id="run-5")
        self.assertEqual(other_code.rowcount, 0)
        same_row = self.upsert(id="f-row2", round_label="R7", source_row=2, warning_codes=json.dumps(["start_time_missing"]), import_run_id="run-5")
        self.assertEqual(same_row.rowcount, 1)
        other_run = self.upsert(id="f-run6", round_label="R8", source_row=2, warning_codes=json.dumps(["start_time_missing"]), import_run_id="run-6")
        self.assertEqual(other_run.rowcount, 0)

    def test_omitting_or_mistyping_the_warning_codes_does_not_bypass_the_gate(self):
        self.assertEqual(self.upsert(id="f-none", round_label="R9", source_row=2, warning_codes=None, import_run_id="run-7").rowcount, 0)
        self.assertEqual(self.upsert(id="f-obj", round_label="R10", source_row=2, warning_codes='{"start_time_missing": true}', import_run_id="run-7").rowcount, 0)
        self.assertEqual(self.upsert(id="f-str", round_label="R11", source_row=2, warning_codes='"start_time_missing"', import_run_id="run-7").rowcount, 0)
        # Known residual: a row that declares no warnings is not checked against the batch, so it imports.
        self.assertEqual(self.upsert(id="f-empty", round_label="R12", source_row=2, warning_codes="[]", import_run_id="run-7").rowcount, 1)

    def test_import_report_stores_provenance_and_issue_counts(self):
        self.assertEqual(self.run_action("record_import_run", "conv-a", id="run-9", org_id="a", kind="fixtures", received_count=3, saved_count=2, rejected_count=1, status="saved",
                                         source_sha256="ab" * 32, blocking_count=1, warning_count=2, acknowledged_count=2).rowcount, 1)
        report = [dict(r) for r in self.run_action("list_import_reports", "conv-a", org_id="a").fetchall()]
        self.assertEqual((report[0]["source_sha256"], report[0]["blocking_count"], report[0]["warning_count"], report[0]["acknowledged_count"]), ("ab" * 32, 1, 2, 2))
        self.assertEqual(self.run_action("list_import_reports", "play-a", org_id="a").fetchall(), [])


if __name__ == "__main__":
    unittest.main()

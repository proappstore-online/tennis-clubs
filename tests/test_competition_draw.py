import copy
import hashlib
import json
import sqlite3
import unittest
from pathlib import Path

from mcp_harness import connect

ROOT = Path(__file__).resolve().parents[1]
MIGRATIONS = json.loads((ROOT / "migrations.json").read_text())["migrations"]
TOOLS = {tool["name"]: tool for tool in json.loads((ROOT / "mcp.json").read_text())["tools"]}

STEPS = [
    "apply_draw_seasons", "apply_draw_divisions", "apply_draw_venues", "apply_draw_external_clubs",
    "apply_draw_external_aliases", "apply_draw_placeholders", "apply_draw_teams", "apply_draw_fixtures",
    "apply_draw_roster", "apply_draw_venue_updates", "apply_draw_fixture_updates", "apply_draw_provenance",
]

SEED = """
INSERT INTO organizations(id,name,slug,created_at,created_by) VALUES ('a','Club A','club-a',1,'founder-a'),('b','Club B','club-b',1,'founder-b');
INSERT INTO club_memberships(id,org_id,user_id,role,display_name,is_active,created_at) VALUES
  ('m1','a','admin-a','admin','Admin A',1,1),
  ('m2','a','conv-a','convenor','Convenor A',1,1),
  ('m3','a','play-a','player','Player A',1,1),
  ('m4','b','admin-b','admin','Admin B',1,1);
"""


def fp(text):
    return hashlib.sha256(text.encode()).hexdigest()


def draw():
    return {
        "source_system": "fixture-book",
        "source_run": "2026-spring-v1",
        "season": {"key": "2026", "name": "2026", "starts_on": "2026-03-01", "ends_on": "2026-10-31", "fingerprint": fp("season-2026")},
        "divisions": [{"key": "A", "name": "Division A", "format": "teams", "fingerprint": fp("division-a")}],
        "venues": [{"key": "central", "name": "Central Courts", "address": "1 Court Rd", "map_url": "", "notes": "Gate 2", "fingerprint": fp("venue-central")}],
        "external_clubs": [{"key": "lakeside", "name": "Lakeside Club", "aliases": ["LC"], "fingerprint": fp("club-lakeside")}],
        "teams": [{"key": "northside", "name": "Northside", "division": "A", "fingerprint": fp("team-northside")}],
        "fixtures": [
            {"key": "r1", "round": "R1", "home": "northside", "away": "lakeside", "away_kind": "external", "venue": "central",
             "starts_at": "2026-03-07T14:00:00+11:00", "time_status": "confirmed", "fingerprint": fp("fixture-r1")},
            {"key": "r2", "round": "R2", "home": "northside", "away": "lakeside", "away_kind": "external", "venue": "central",
             "starts_at": "2026-03-14T00:00:00+11:00", "time_status": "tbc", "fingerprint": fp("fixture-r2")},
        ],
        "rosters": [{"fixture": "r1", "team": "northside", "players": ["Sam Smith", "Alex Lee"]}],
    }


def refingerprint(payload, section, key, text):
    for record in payload[section] if isinstance(payload[section], list) else [payload[section]]:
        if record.get("key") == key or section == "season":
            record["fingerprint"] = fp(text)
            return payload
    raise KeyError(key)


class CompetitionDrawTests(unittest.TestCase):
    def setUp(self):
        self.db = connect()
        self.db.row_factory = sqlite3.Row
        for migration in MIGRATIONS:
            self.db.executescript(migration["sql"])
        self.db.executescript(SEED)
        self.payload = draw()
        self.run_id = "run-1"

    def tearDown(self):
        self.db.close()

    def call(self, tool, user="admin-a", payload=None, **params):
        values = {"__user_id": user, "__now": 1000, "org_id": "a", "import_run_id": self.run_id,
                  "payload": json.dumps(self.payload if payload is None else payload), **params}
        return self.db.execute(TOOLS[tool]["sql"], values)

    def plan(self, user="admin-a", payload=None):
        return [dict(row) for row in self.call("import_competition_draw", user=user, payload=payload).fetchall()]

    def actions(self, user="admin-a", payload=None):
        return sorted({(row["entity_type"], row["source_key"], row["action"]) for row in self.plan(user, payload)})

    def step(self, tool, user="admin-a", payload=None):
        before = self.db.total_changes
        self.call(tool, user=user, payload=payload)
        return self.db.total_changes - before

    def apply_all(self, payload=None, steps=STEPS):
        return {step: self.step(step, payload=payload) for step in steps}

    def count(self, table):
        return self.db.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]

    def test_dry_run_plans_every_record_and_writes_nothing(self):
        plan = self.plan()
        self.assertEqual({row["severity"] for row in plan}, {"info"})
        planned = {(row["entity_type"], row["source_key"]): row["action"] for row in plan}
        self.assertEqual(planned[("season", "2026")], "create")
        self.assertEqual(planned[("division", "A")], "create")
        self.assertEqual(planned[("fixture", "r1")], "create")
        self.assertEqual(planned[("external_alias", "LC")], "create")
        self.assertEqual(self.count("seasons"), 0)
        self.assertEqual(self.count("fixtures"), 0)
        self.assertEqual(self.count("import_provenance"), 0)

    def test_apply_creates_the_draw_and_a_rerun_changes_nothing(self):
        changes = self.apply_all()
        self.assertEqual(changes["apply_draw_seasons"], 1)
        self.assertEqual(changes["apply_draw_divisions"], 1)
        self.assertEqual(changes["apply_draw_venues"], 1)
        self.assertEqual(changes["apply_draw_external_clubs"], 1)
        self.assertEqual(changes["apply_draw_external_aliases"], 1)
        self.assertEqual(changes["apply_draw_placeholders"], 1)
        self.assertEqual(changes["apply_draw_teams"], 1)
        self.assertEqual(changes["apply_draw_fixtures"], 2)
        self.assertEqual(changes["apply_draw_roster"], 2)
        self.assertEqual(changes["apply_draw_provenance"], 7)
        self.assertEqual(self.count("import_provenance"), 7)
        self.assertEqual({row["action"] for row in self.plan()}, {"unchanged"})
        self.assertEqual(self.apply_all(), {step: 0 for step in STEPS})
        self.assertEqual(self.count("fixtures"), 2)
        self.assertEqual(self.count("roster_players"), 2)

    def test_external_opponent_is_a_placeholder_and_tbc_is_not_confirmed(self):
        self.apply_all()
        rows = {row["round_label"]: dict(row) for row in self.db.execute(
            "SELECT f.round_label, f.time_status, f.starts_at, t.is_external FROM fixtures f JOIN teams t ON t.id=f.away_team_id").fetchall()}
        self.assertEqual(rows["R1"]["is_external"], 1)
        self.assertEqual((rows["R1"]["time_status"], rows["R2"]["time_status"]), ("confirmed", "tbc"))
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM teams WHERE name='Lakeside Club' AND is_external=0").fetchone()[0], 0)
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM external_club_aliases WHERE normalized_alias='lc'").fetchone()[0], 1)

    def test_existing_records_are_adopted_not_duplicated(self):
        self.db.execute("INSERT INTO venues(id,org_id,name,address,map_url,notes,convenor_phone,created_at) VALUES ('v-manual','a','central courts',NULL,NULL,NULL,NULL,1)")
        plan = {(r["entity_type"], r["source_key"]): r["action"] for r in self.plan()}
        self.assertEqual(plan[("venue", "central")], "adopt")
        self.apply_all()
        self.assertEqual(self.count("venues"), 1)
        entity = self.db.execute("SELECT entity_id FROM import_provenance WHERE entity_type='venue' AND source_key='central'").fetchone()[0]
        self.assertEqual(entity, "v-manual")

    def test_changed_source_updates_fixture_time_but_never_downgrades_or_changes_teams(self):
        self.apply_all()
        self.payload["fixtures"][0]["starts_at"] = "2026-03-07T15:00:00+11:00"
        refingerprint(self.payload, "fixtures", "r1", "fixture-r1-v2")
        self.assertIn(("fixture", "r1", "update"), self.actions())
        self.assertEqual(self.step("apply_draw_fixture_updates"), 1)
        self.assertEqual(self.db.execute("SELECT starts_at FROM fixtures WHERE round_label='R1'").fetchone()[0], "2026-03-07T15:00:00+11:00")
        self.step("apply_draw_provenance")
        self.assertIn(("fixture", "r1", "unchanged"), self.actions())

        self.payload["fixtures"][0]["starts_at"] = "2026-03-07T00:00:00+11:00"
        self.payload["fixtures"][0]["time_status"] = "tbc"
        refingerprint(self.payload, "fixtures", "r1", "fixture-r1-v3")
        self.assertEqual(self.step("apply_draw_fixture_updates"), 0)
        self.assertEqual(self.db.execute("SELECT time_status FROM fixtures WHERE round_label='R1'").fetchone()[0], "confirmed")

        self.payload["teams"][0]["name"] = "Northside Renamed"
        refingerprint(self.payload, "teams", "northside", "team-northside-v2")
        self.assertIn(("team", "northside", "conflict"), self.actions())
        self.assertEqual(self.step("apply_draw_teams"), 0)

    def test_validation_errors_block_every_write(self):
        self.payload["venues"][0]["phone"] = "0400 000 000"
        self.payload["fixtures"][1]["home"] = "unknown-team"
        plan = self.plan()
        codes = {(r["entity_type"], r["message"]) for r in plan if r["severity"] == "blocking"}
        self.assertIn(("venue", "contact_field_present"), codes)
        self.assertIn(("fixture", "unknown_home_team"), codes)
        self.assertEqual({step: self.step(step) for step in STEPS}, {step: 0 for step in STEPS})
        self.assertEqual(self.count("seasons") + self.count("fixtures") + self.count("venues") + self.count("import_provenance"), 0)

    def test_roster_contact_details_are_rejected(self):
        self.payload["rosters"][0]["players"] = [{"name": "Sam Smith", "contact": "0400 000 000"}]
        self.assertIn(("roster", "invalid_player"), {(r["entity_type"], r["message"]) for r in self.plan() if r["severity"] == "blocking"})
        self.assertEqual(self.step("apply_draw_seasons"), 0)

    def test_players_are_stored_by_name_without_contact_details(self):
        self.apply_all()
        rows = [dict(row) for row in self.db.execute("SELECT player_name, contact, availability FROM roster_players ORDER BY player_name").fetchall()]
        self.assertEqual(rows, [{"player_name": "Alex Lee", "contact": None, "availability": "pending"},
                                {"player_name": "Sam Smith", "contact": None, "availability": "pending"}])

    def test_non_admins_and_other_clubs_cannot_plan_or_apply(self):
        for user in ("conv-a", "play-a", "admin-b"):
            with self.subTest(user=user):
                self.assertEqual(self.plan(user=user), [])
                self.assertEqual({step: self.step(step, user=user) for step in STEPS}, {step: 0 for step in STEPS})
        self.assertEqual(self.count("seasons"), 0)

    def test_ambiguous_names_and_alias_collisions_are_conflicts(self):
        self.db.executescript("""
          INSERT INTO seasons(id,org_id,name,starts_on,ends_on,status,created_at) VALUES ('s-manual','a','2026','2026-01-01','2026-12-31','upcoming',1);
          INSERT INTO teams(id,org_id,division_id,name,colour,created_at,is_external) VALUES ('t1','a',NULL,'Northside',NULL,1,0),('t2','a',NULL,'northside ',NULL,1,0);
          INSERT INTO external_clubs(id,org_id,canonical_name,normalized_name,created_at) VALUES ('ec-other','a','Other Club','other club',1);
          INSERT INTO external_club_aliases(id,org_id,external_club_id,alias,normalized_alias,created_at) VALUES ('al-other','a','ec-other','LC','lc',1);
        """)
        plan = {(r["entity_type"], r["source_key"]): (r["action"], r["severity"]) for r in self.plan()}
        self.assertEqual(plan[("team", "northside")], ("conflict", "blocking"))
        self.assertEqual(plan[("external_alias", "LC")], ("conflict", "blocking"))
        self.apply_all()
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM external_club_aliases WHERE normalized_alias='lc'").fetchone()[0], 1)
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM teams WHERE lower(trim(name))='northside' AND is_external=0").fetchone()[0], 2)

    def test_an_alias_can_repeat_across_clubs_but_not_within_one(self):
        self.db.executescript("""
          INSERT INTO organizations(id,name,slug,created_at,created_by) VALUES ('c','Club C','club-c',1,'x');
          INSERT INTO external_clubs(id,org_id,canonical_name,normalized_name,created_at) VALUES ('ec-c','c','Elsewhere','elsewhere',1);
          INSERT INTO external_club_aliases(id,org_id,external_club_id,alias,normalized_alias,created_at) VALUES ('al-c','c','ec-c','LC','lc',1);
        """)
        self.apply_all()
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM external_club_aliases WHERE normalized_alias='lc'").fetchone()[0], 2)

    def test_a_partial_import_resumes_on_rerun_without_duplicates(self):
        self.apply_all(steps=STEPS[:7])
        self.assertEqual(self.count("fixtures"), 0)
        self.apply_all()
        self.assertEqual(self.count("fixtures"), 2)
        self.assertEqual(self.count("roster_players"), 2)
        self.assertEqual(self.count("import_provenance"), 7)

    def test_import_run_and_report_are_recorded_with_importer_and_counts(self):
        plan = self.plan()
        self.apply_all()
        outcomes = json.dumps([{"entity_type": r["entity_type"], "source_key": r["source_key"], "action": "create" if r["action"] == "unchanged" else r["action"], "severity": r["severity"], "message": r["message"]} for r in plan])
        self.call("record_draw_import_run", source_system="fixture-book", source_run="2026-spring-v1", payload_sha256=fp(json.dumps(self.payload)))
        self.call("record_draw_import_outcomes", outcomes=outcomes)
        run = dict(self.db.execute("SELECT source_system,source_run,importer_user_id FROM draw_import_runs WHERE id='run-1'").fetchone())
        self.assertEqual(run, {"source_system": "fixture-book", "source_run": "2026-spring-v1", "importer_user_id": "admin-a"})
        report = {row["action"]: row["records"] for row in self.call("get_draw_import_report", import_run_id="run-1").fetchall()}
        self.assertEqual(sum(report.values()), len(plan))
        self.assertEqual(self.call("get_draw_import_report", user="conv-a", import_run_id="run-1").fetchall(), [])

    def test_a_run_is_recorded_only_by_admins_of_its_club(self):
        self.call("record_draw_import_run", user="admin-b", source_system="fixture-book", source_run="x", payload_sha256="0" * 64)
        self.assertEqual(self.count("draw_import_runs"), 0)


if __name__ == "__main__":
    unittest.main()

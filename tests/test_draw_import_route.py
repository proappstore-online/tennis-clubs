import copy
import json
import os
import re
import subprocess
import unittest
from pathlib import Path

# The worker's POST /draw/import route (issue #1). The worker runs under Node against a fake PAS binding that executes the
# real mcp.json SQL on an in-memory SQLite database (node:sqlite). batch() is a real transaction, so the atomicity
# assertions check what the database actually holds. Seed and payload are the ones test_competition_draw uses.
from test_competition_draw import SEED, draw

ROOT = Path(__file__).resolve().parents[1]
WORKER = ROOT / "worker" / "src" / "app.js"
MIGRATIONS = json.loads((ROOT / "migrations.json").read_text())["migrations"]

ADMIN = {"user_id": "admin-a", "club_id": "a"}
CONVENOR = {"user_id": "conv-a", "club_id": "a"}
PLAYER = {"user_id": "play-a", "club_id": "a"}

HARNESS = r"""
import worker from WORKER_PATH;
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
const input = JSON.parse(readFileSync(0, 'utf8'));
const tools = Object.fromEntries(JSON.parse(readFileSync(input.mcp_path, 'utf8')).tools.map((t) => [t.name, t]));
const results = [];
for (const sc of input.scenarios) {
  const db = new DatabaseSync(':memory:');
  for (const sql of input.setup) db.exec(sql);
  const trace = [];
  let fault = null;
  const run = (name, params, userId) => {
    trace.push(name);
    if (name === fault) throw new Error('synthetic failure in ' + name);
    const tool = tools[name];
    const values = { __user_id: userId, __now: 1000 + trace.length, ...params };
    const names = [...new Set([...tool.sql.matchAll(/(?<![:\w]):([A-Za-z_]\w*)/g)].map((m) => m[1]))];
    const bound = Object.fromEntries(names.map((n) => [n, values[n] ?? null]));
    const statement = db.prepare(tool.sql);
    if (tool.operation === 'query') return { rows: statement.all(bound) };
    const info = statement.run(bound);
    return { changes: info.changes };
  };
  const PAS = {
    actions: {
      call: async (name, params, ctx) => run(name, params, ctx.as?.user_id ?? ''),
      batch: async (calls, ctx) => {
        if (calls.length > 500) throw new Error('too many statements');
        db.exec('BEGIN');
        trace.push('BATCH:begin');
        try {
          const out = calls.map((c) => ({ name: c.name, results: [run(c.name, c.params ?? {}, ctx.as?.user_id ?? '')] }));
          db.exec('COMMIT');
          trace.push('BATCH:commit');
          return out;
        } catch (error) {
          db.exec('ROLLBACK');
          trace.push('BATCH:rollback');
          throw error;
        }
      },
    },
    secrets: { get: async () => null },
    connectors: { token: async () => null },
    storage: { get: async () => null, put: async () => ({}) },
    log: async () => true,
    rooms: { publish: async () => true },
  };
  const env = { PAS_WORKER_TOKEN: 'worker-token', PAS };
  const responses = [];
  for (const [i, step] of sc.steps.entries()) {
    fault = step.fault ?? null;
    const envelope = { id: `${sc.name}-${i}`, type: 'http', attempt: 1, caller: step.caller ?? null, payload: step.payload };
    const response = await worker.fetch(new Request('https://tennis-clubs.proappstore.online/.pas/worker', { method: 'POST', body: JSON.stringify(envelope) }), env);
    responses.push({ status: response.status, body: await response.text() });
  }
  fault = null;
  const queries = Object.fromEntries(Object.entries(sc.queries ?? {}).map(([k, sql]) => [k, db.prepare(sql).get()]));
  results.push({ name: sc.name, responses, trace, queries });
  db.close();
}
process.stdout.write(JSON.stringify(results));
"""

COUNT = {
    "seasons": "SELECT COUNT(*) AS n FROM seasons WHERE org_id='a' AND name='2026'",
    "divisions": "SELECT COUNT(*) AS n FROM divisions WHERE name='Division A'",
    "teams": "SELECT COUNT(*) AS n FROM teams WHERE org_id='a' AND division_id IS NOT NULL AND name='Northside'",
    "fixtures": "SELECT COUNT(*) AS n FROM fixtures WHERE org_id='a'",
    "draw_import_runs": "SELECT COUNT(*) AS n FROM draw_import_runs",
    "draw_import_records": "SELECT COUNT(*) AS n FROM draw_import_records",
    "import_provenance": "SELECT COUNT(*) AS n FROM import_provenance",
}
ALL_COUNTS = {key: sql for key, sql in COUNT.items()}


def body_of(payload_obj):
    return json.dumps(payload_obj)


def request(payload_body=None, *, method="POST", query="org=a", caller=ADMIN, fault=None):
    body = payload_body if isinstance(payload_body, str) else (body_of(payload_body) if payload_body is not None else None)
    step = {"caller": caller, "payload": {"method": method, "path": "/draw/import", "query": query, "body": body or "", "body_encoding": "utf8"}}
    if fault:
        step["fault"] = fault
    return step


def run(scenarios):
    setup = [migration["sql"] for migration in MIGRATIONS] + [SEED]
    source = HARNESS.replace("WORKER_PATH", json.dumps(WORKER.as_uri()))
    stdin = json.dumps({"setup": setup, "mcp_path": str(ROOT / "mcp.json"), "scenarios": scenarios})
    result = subprocess.run(["node", "--disable-warning=ExperimentalWarning", "--input-type=module", "-e", source], input=stdin,
                            text=True, capture_output=True, cwd=ROOT, env={**os.environ}, check=True)
    return {item["name"]: item for item in json.loads(result.stdout)}


def zero_counts(queries):
    return {key: queries[key]["n"] for key in COUNT}


def with_invalid_home(payload):
    bad = copy.deepcopy(payload)
    bad["fixtures"][0]["home"] = "missing-team"
    return bad


class DrawImportRouteTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        valid = draw()
        cls.scenarios = run([
            {"name": "valid", "steps": [request(valid)], "queries": ALL_COUNTS},
            {"name": "dry_run", "steps": [request(valid, query="org=a&dry_run=true")], "queries": ALL_COUNTS},
            {"name": "rerun", "steps": [request(valid), request(valid)], "queries": ALL_COUNTS},
            {"name": "invalid", "steps": [request(with_invalid_home(valid))], "queries": ALL_COUNTS},
            {"name": "invalid_dry_run", "steps": [request(with_invalid_home(valid), query="org=a&dry_run=true")], "queries": ALL_COUNTS},
            {"name": "player", "steps": [request(valid, caller=PLAYER)], "queries": ALL_COUNTS},
            {"name": "convenor", "steps": [request(valid, caller=CONVENOR)], "queries": ALL_COUNTS},
            {"name": "no_caller", "steps": [request(valid, caller=None)], "queries": ALL_COUNTS},
            {"name": "wrong_method", "steps": [request(valid, method="GET")], "queries": ALL_COUNTS},
            {"name": "not_json", "steps": [request("this is not json")], "queries": ALL_COUNTS},
            {"name": "unknown_club", "steps": [request(valid, query="org=zz%20zz")], "queries": ALL_COUNTS},
            {"name": "partial_failure", "steps": [request(valid, fault="apply_draw_fixtures")], "queries": ALL_COUNTS},
            {"name": "retry_after_failure", "steps": [request(valid, fault="apply_draw_fixtures"), request(valid)], "queries": ALL_COUNTS},
        ])

    def response(self, name, index=0):
        item = self.scenarios[name]["responses"][index]
        return item["status"], json.loads(item["body"]) if item["body"].startswith("{") else item["body"]

    # Valid import

    def test_valid_import_creates_every_record_in_one_transaction(self):
        status, report = self.response("valid")
        self.assertEqual(status, 201)
        self.assertEqual(report["status"], "imported")
        self.assertTrue(report["valid"])
        self.assertEqual(report["counts"]["created"], 10)
        self.assertEqual(report["planned"]["created"], 10)
        self.assertEqual(report["importer"], "admin-a")
        self.assertEqual(report["source"]["run"], "2026-spring-v1")
        self.assertEqual(len(report["source"]["payload_sha256"]), 64)
        self.assertRegex(report["import_time"], r"^\d{4}-\d{2}-\d{2}T")
        self.assertEqual(report["steps"]["apply_draw_seasons"], 1)
        self.assertEqual(report["steps"]["apply_draw_fixtures"], 2)
        self.assertTrue(report["import_run_id"])
        queries = self.scenarios["valid"]["queries"]
        self.assertEqual(zero_counts(queries)["seasons"], 1)
        self.assertEqual(zero_counts(queries)["teams"], 1)
        self.assertEqual(zero_counts(queries)["fixtures"], 2)
        self.assertEqual(zero_counts(queries)["draw_import_runs"], 1)
        self.assertGreater(zero_counts(queries)["import_provenance"], 0)
        trace = self.scenarios["valid"]["trace"]
        self.assertEqual(trace[0], "import_competition_draw", "the plan is made before any write")
        self.assertEqual(trace[1], "BATCH:begin")
        self.assertEqual(trace[2], "record_draw_import_run")
        self.assertEqual(trace[-2], "record_draw_import_outcomes")
        self.assertEqual(trace[-1], "BATCH:commit")

    def test_roster_names_are_stored_but_never_reported(self):
        status, report = self.response("valid")
        self.assertEqual(status, 201)
        body = self.scenarios["valid"]["responses"][0]["body"]
        self.assertNotIn("Sam Smith", body)
        self.assertNotIn("Alex Lee", body)
        roster = [record for record in report["records"] if record["entity_type"] == "roster"]
        self.assertEqual(len(roster), 2)
        self.assertTrue(all(record["source_key"] is None for record in roster))

    # Dry run

    def test_dry_run_plans_every_create_and_writes_nothing(self):
        status, report = self.response("dry_run")
        self.assertEqual(status, 200)
        self.assertEqual(report["status"], "dry_run")
        self.assertTrue(report["valid"])
        self.assertEqual(report["planned"]["created"], 10)
        self.assertEqual(report["counts"], {"created": 0, "updated": 0, "skipped": 0, "conflicted": 0, "failed": 0})
        self.assertEqual({key: value for key, value in zero_counts(self.scenarios["dry_run"]["queries"]).items()}, {key: 0 for key in COUNT})

    def test_dry_run_of_an_invalid_payload_reports_it_as_not_valid(self):
        status, report = self.response("invalid_dry_run")
        self.assertEqual(status, 200)
        self.assertFalse(report["valid"])
        self.assertTrue(any(record["severity"] == "blocking" for record in report["records"]))
        self.assertEqual(sum(zero_counts(self.scenarios["invalid_dry_run"]["queries"]).values()), 0)

    # Invalid payload

    def test_invalid_payload_is_refused_before_any_write(self):
        status, report = self.response("invalid")
        self.assertEqual(status, 422)
        self.assertEqual(report["status"], "rejected")
        self.assertFalse(report["valid"])
        codes = {error["code"] for error in report["errors"]}
        self.assertIn("unknown_home_team", codes)
        self.assertEqual(sum(zero_counts(self.scenarios["invalid"]["queries"]).values()), 0)
        self.assertNotIn("BATCH:begin", self.scenarios["invalid"]["trace"])

    def test_malformed_json_is_refused_with_a_clear_code(self):
        status, report = self.response("not_json")
        self.assertEqual(status, 400)
        self.assertEqual(report["errors"], [{"code": "invalid_json"}])

    # Authorisation

    def test_only_club_administrators_can_plan_or_import(self):
        for name in ["player", "convenor"]:
            with self.subTest(caller=name):
                status, report = self.response(name)
                self.assertEqual(status, 403)
                self.assertEqual(report["errors"], [{"code": "not_club_administrator"}])
                self.assertEqual(sum(zero_counts(self.scenarios[name]["queries"]).values()), 0)

    def test_a_request_without_a_platform_caller_is_refused(self):
        status, _ = self.response("no_caller")
        self.assertEqual(status, 401)
        self.assertEqual(sum(zero_counts(self.scenarios["no_caller"]["queries"]).values()), 0)

    def test_wrong_method_and_unknown_club_are_refused(self):
        self.assertEqual(self.response("wrong_method")[0], 405)
        self.assertEqual(self.response("unknown_club")[0], 404)
        self.assertEqual(sum(zero_counts(self.scenarios["unknown_club"]["queries"]).values()), 0)

    # Partial failure

    def test_a_failure_part_way_through_leaves_no_records_behind(self):
        status, report = self.response("partial_failure")
        self.assertEqual(status, 500)
        self.assertEqual(report["status"], "rolled_back")
        self.assertEqual(report["errors"], [{"code": "transaction_failed"}])
        queries = zero_counts(self.scenarios["partial_failure"]["queries"])
        self.assertEqual(queries["seasons"], 0, "the season written before the failing step must be rolled back")
        self.assertEqual(queries["teams"], 0)
        self.assertEqual(queries["fixtures"], 0)
        self.assertEqual(queries["draw_import_runs"], 0, "the run record is part of the same transaction")
        self.assertEqual(queries["import_provenance"], 0)
        trace = self.scenarios["partial_failure"]["trace"]
        self.assertIn("BATCH:rollback", trace)
        self.assertNotIn("BATCH:commit", trace)

    def test_the_same_import_succeeds_after_a_rolled_back_attempt(self):
        self.assertEqual(self.response("retry_after_failure", 0)[0], 500)
        status, report = self.response("retry_after_failure", 1)
        self.assertEqual(status, 201)
        self.assertEqual(report["counts"]["created"], 10)
        queries = zero_counts(self.scenarios["retry_after_failure"]["queries"])
        self.assertEqual(queries["seasons"], 1)
        self.assertEqual(queries["fixtures"], 2)
        self.assertEqual(queries["draw_import_runs"], 1, "only the committed attempt leaves a run record")

    # Idempotency

    def test_rerunning_the_same_payload_skips_every_record_and_duplicates_nothing(self):
        first_status, first = self.response("rerun", 0)
        second_status, second = self.response("rerun", 1)
        self.assertEqual((first_status, second_status), (201, 201))
        self.assertEqual(first["counts"]["created"], 10)
        self.assertEqual(second["counts"]["created"], 0)
        self.assertEqual(second["counts"]["skipped"], 10)
        self.assertEqual(second["planned"]["skipped"], 10)
        queries = zero_counts(self.scenarios["rerun"]["queries"])
        self.assertEqual(queries["seasons"], 1)
        self.assertEqual(queries["teams"], 1)
        self.assertEqual(queries["fixtures"], 2)
        self.assertEqual(queries["draw_import_runs"], 2, "each attempt is recorded with its own run")


if __name__ == "__main__":
    unittest.main()

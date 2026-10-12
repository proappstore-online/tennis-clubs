import base64
import hashlib
import json
import os
import re
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
WORKER = ROOT / "worker" / "src" / "app.js"
MCP = {tool["name"]: tool for tool in json.loads((ROOT / "mcp.json").read_text())["tools"]}

# Fake placeholder bytes: no real document is used or stored in this repository.
PDF = b"%PDF-1.4 placeholder document for tests\n"
OTHER = b"%PDF-1.4 different placeholder bytes!!\n"
SHA = hashlib.sha256(PDF).hexdigest()
CALLER = {"user_id": "play-a", "club_id": "a"}
DOCUMENT = {"id": "d1", "title": "Parent guidance", "content_type": "application/pdf", "byte_size": len(PDF), "sha256": SHA}

HARNESS = r"""
import worker from WORKER_PATH;
import { readFileSync } from 'node:fs';
const input = JSON.parse(readFileSync(0, 'utf8'));
const results = [];
for (const sc of input.scenarios) {
  const calls = [];
  const puts = [];
  const store = new Map(Object.entries(sc.storage ?? {}).map(([k, v]) => [k, { body: Buffer.from(v, 'base64'), contentType: 'application/pdf' }]));
  const env = {
    PAS_WORKER_TOKEN: 'worker-token',
    PAS: {
      actions: {
        call: async (name, params, ctx) => {
          calls.push({ name, params, as: ctx.as ?? null, token: ctx.token });
          const reply = sc.responses?.[name] ?? {};
          if (reply.throw) throw new Error(reply.throw);
          return reply.value ?? {};
        },
        batch: async () => [],
      },
      storage: {
        get: async (key) => store.get(key) ?? null,
        put: async (key, body, opts, ctx) => {
          puts.push({ key, size: body.byteLength, contentType: opts.contentType, token: ctx.token, as: ctx.as ?? null });
          store.set(key, { body: Buffer.from(body), contentType: opts.contentType });
          return { key, size: body.byteLength };
        },
      },
      log: async () => true,
    },
  };
  const envelope = { id: 'evt-1', type: 'http', attempt: 1, caller: sc.caller, payload: sc.payload };
  const response = await worker.fetch(new Request('https://tennis-clubs.proappstore.online/.pas/worker', { method: 'POST', body: JSON.stringify(envelope) }), env);
  const bytes = Buffer.from(await response.arrayBuffer());
  results.push({
    name: sc.name,
    status: response.status,
    contentType: response.headers.get('content-type'),
    disposition: response.headers.get('content-disposition'),
    cache: response.headers.get('cache-control'),
    body: bytes.toString('base64'),
    calls,
    puts,
  });
}
process.stdout.write(JSON.stringify(results));
"""


def envelope_payload(method="GET", path="/documents/d1/download", query="org=a", headers=None, body=None):
    payload = {"method": method, "path": path, "query": query, "headers": headers or {}}
    if body is not None:
        payload["body"] = base64.b64encode(body).decode()
        payload["body_encoding"] = "base64"
    return payload


def run(scenarios):
    source = HARNESS.replace("WORKER_PATH", json.dumps(WORKER.as_uri()))
    result = subprocess.run(["node", "--input-type=module", "-e", source], input=json.dumps({"scenarios": scenarios}),
                            text=True, capture_output=True, cwd=ROOT, env={**os.environ}, check=True)
    return {item["name"]: item for item in json.loads(result.stdout)}


def check_document(**overrides):
    return {"rows": [{**DOCUMENT, **overrides}]}


class DocumentWorkerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.results = run([
            {"name": "no-caller", "caller": None, "payload": envelope_payload()},
            {"name": "unknown-route", "caller": CALLER, "payload": envelope_payload(path="/documents/d1/delete")},
            {"name": "bad-org", "caller": CALLER, "payload": envelope_payload(query="org=a%20b")},
            {"name": "denied", "caller": CALLER, "payload": envelope_payload(),
             "responses": {"check_document_access": {"value": {"rows": []}}}},
            {"name": "missing-file", "caller": CALLER, "payload": envelope_payload(),
             "responses": {"check_document_access": {"value": check_document()}}},
            {"name": "tampered-file", "caller": CALLER, "payload": envelope_payload(),
             "responses": {"check_document_access": {"value": check_document()}},
             "storage": {"docs/a/d1": base64.b64encode(OTHER).decode()}},
            {"name": "download", "caller": CALLER, "payload": envelope_payload(),
             "responses": {"check_document_access": {"value": check_document()}},
             "storage": {"docs/a/d1": base64.b64encode(PDF).decode()}},
            {"name": "download-wrong-method", "caller": CALLER, "payload": envelope_payload(method="POST")},
            {"name": "upload-unregistered", "caller": CALLER,
             "payload": envelope_payload(method="POST", path="/documents/d1/upload", headers={"content-type": "application/pdf"}, body=PDF),
             "responses": {"check_document_upload": {"value": {"rows": []}}}},
            {"name": "upload-wrong-type", "caller": CALLER,
             "payload": envelope_payload(method="POST", path="/documents/d1/upload", headers={"content-type": "image/png"}, body=PDF),
             "responses": {"check_document_upload": {"value": check_document()}}},
            {"name": "upload-wrong-size", "caller": CALLER,
             "payload": envelope_payload(method="POST", path="/documents/d1/upload", headers={"content-type": "application/pdf"}, body=PDF + b"x"),
             "responses": {"check_document_upload": {"value": check_document()}}},
            {"name": "upload-wrong-hash", "caller": CALLER,
             "payload": envelope_payload(method="POST", path="/documents/d1/upload", headers={"content-type": "application/pdf"}, body=OTHER),
             "responses": {"check_document_upload": {"value": check_document(byte_size=len(OTHER))}}},
            {"name": "upload", "caller": CALLER,
             "payload": envelope_payload(method="POST", path="/documents/d1/upload", headers={"Content-Type": "application/pdf; charset=binary"}, body=PDF),
             "responses": {"check_document_upload": {"value": check_document()}}},
            {"name": "upload-get", "caller": CALLER, "payload": envelope_payload(path="/documents/d1/upload")},
        ])

    def test_callers_must_be_signed_in_and_routes_are_strict(self):
        self.assertEqual(self.results["no-caller"]["status"], 401)
        self.assertEqual(self.results["unknown-route"]["status"], 404)
        self.assertEqual(self.results["bad-org"]["status"], 404)
        self.assertEqual(self.results["download-wrong-method"]["status"], 405)
        self.assertEqual(self.results["upload-get"]["status"], 405)
        self.assertEqual(self.results["no-caller"]["calls"], [])

    def test_downloads_are_authorised_as_the_user_and_refused_without_revealing_existence(self):
        denied = self.results["denied"]
        self.assertEqual(denied["status"], 404)
        self.assertEqual([c["name"] for c in denied["calls"]], ["check_document_access", "log_document_access"])
        self.assertEqual(denied["calls"][1]["params"]["outcome"], "denied")
        self.assertTrue(all(c["as"] == CALLER for c in denied["calls"]))
        self.assertEqual(denied["puts"], [])

    def test_a_stored_file_is_served_only_after_authorisation_and_integrity_checks(self):
        ok = self.results["download"]
        self.assertEqual(ok["status"], 200)
        self.assertEqual(base64.b64decode(ok["body"]), PDF)
        self.assertEqual(ok["contentType"], "application/pdf")
        self.assertEqual(ok["disposition"], 'attachment; filename="Parent guidance"')
        self.assertEqual(ok["cache"], "private, no-store")
        self.assertEqual([c["name"] for c in ok["calls"]], ["check_document_access", "log_document_access"])
        self.assertEqual(ok["calls"][1]["params"]["outcome"], "allowed")
        self.assertEqual(self.results["missing-file"]["status"], 503)
        self.assertEqual(self.results["tampered-file"]["status"], 500)
        self.assertNotIn(b"docs/a", base64.b64decode(ok["body"]))

    def test_uploads_are_checked_against_the_registration_before_bytes_are_stored(self):
        self.assertEqual(self.results["upload-unregistered"]["status"], 404)
        self.assertEqual(self.results["upload-wrong-type"]["status"], 415)
        self.assertEqual(self.results["upload-wrong-size"]["status"], 422)
        self.assertEqual(self.results["upload-wrong-hash"]["status"], 422)
        for name in ("upload-unregistered", "upload-wrong-type", "upload-wrong-size", "upload-wrong-hash"):
            with self.subTest(name=name):
                self.assertEqual(self.results[name]["puts"], [])
                self.assertNotIn("mark_document_stored", [c["name"] for c in self.results[name]["calls"]])

    def test_a_valid_upload_stores_the_bytes_marks_them_and_audits_the_actor(self):
        ok = self.results["upload"]
        self.assertEqual(ok["status"], 201)
        self.assertEqual(json.loads(base64.b64decode(ok["body"])), {"status": "stored", "sha256": SHA})
        self.assertEqual(ok["puts"], [{"key": "docs/a/d1", "size": len(PDF), "contentType": "application/pdf", "token": "worker-token", "as": None}])
        names = [c["name"] for c in ok["calls"]]
        self.assertEqual(names, ["check_document_upload", "mark_document_stored", "record_audit_event"])
        mark = ok["calls"][1]["params"]
        self.assertEqual((mark["storage_key"], mark["sha256"], mark["byte_size"]), ("docs/a/d1", SHA, len(PDF)))
        self.assertTrue(all(c["as"] == CALLER for c in ok["calls"]))

    def test_every_action_the_worker_calls_exists_with_matching_parameters(self):
        source = WORKER.read_text()
        for name, body in re.findall(r"client\.call\('([a-z_]+)',\s*\{([^}]*)\}", source):
            with self.subTest(action=name):
                self.assertIn(name, MCP)
                declared = set(MCP[name].get("params", {}))
                passed = set(re.findall(r"([a-z_]+):", body))
                self.assertTrue(passed <= declared, passed - declared)
        self.assertIn("check_document_access", MCP)

    def test_no_response_ever_discloses_a_storage_key(self):
        for name, result in self.results.items():
            with self.subTest(scenario=name):
                self.assertNotIn(b"docs/", base64.b64decode(result["body"]))


if __name__ == "__main__":
    unittest.main()

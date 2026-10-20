import json
import unittest
from pathlib import Path

from mcp_harness import connect

# An audit row names the action, the outcome, the actor, the club and the target record. The target is an identifier:
# record_audit_event refuses one that looks like a name, a contact or free text (issue #29).
ROOT = Path(__file__).resolve().parents[1]
MIGRATIONS = json.loads((ROOT / "migrations.json").read_text())["migrations"]
TOOLS = {tool["name"]: tool for tool in json.loads((ROOT / "mcp.json").read_text())["tools"]}

SEED = """
INSERT INTO organizations(id,name,slug,created_at,created_by) VALUES ('a','Club A','club-a',1,'founder-a');
INSERT INTO club_memberships(id,org_id,user_id,role,display_name,is_active,created_at) VALUES ('m1','a','conv-a','convenor','Convenor A',1,1);
"""


class AuditPayloadTests(unittest.TestCase):
    def setUp(self):
        self.db = connect()
        for migration in MIGRATIONS:
            self.db.executescript(migration["sql"])
        self.db.executescript(SEED)
        self.count = 0

    def tearDown(self):
        self.db.close()

    def record(self, target_id, user="conv-a"):
        self.count += 1
        return self.db.execute(TOOLS["record_audit_event"]["sql"], {
            "__user_id": user, "__now": 1000, "id": f"aud-{self.count}", "org_id": "a", "action": "update_venue",
            "target_type": "venue", "target_id": target_id, "outcome": "succeeded",
        }).rowcount

    def test_identifiers_are_recorded(self):
        self.assertEqual(self.record("3f2c9a1e-8d4b-4c2a-9f7e-1a2b3c4d5e6f"), 1)
        self.assertEqual(self.record("fixture-42:play-a"), 1)
        self.assertEqual(self.record(None), 1, "a record without a target is allowed")

    def test_a_name_is_not_recorded_as_a_target(self):
        self.assertEqual(self.record("Sam Smith"), 0)
        self.assertEqual(self.record("fixture-42 Sam Smith"), 0)

    def test_a_contact_is_not_recorded_as_a_target(self):
        self.assertEqual(self.record("sam@example.com"), 0)
        self.assertEqual(self.record("fixture-42:sam@example.com"), 0)

    def test_free_text_is_not_recorded_as_a_target(self):
        self.assertEqual(self.record("x" * 121), 0)
        self.assertEqual(self.record("x" * 120), 1, "the limit is an identifier's length")

    def test_no_audit_row_holds_a_refused_target(self):
        self.record("Sam Smith")
        self.record("sam@example.com")
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM audit_events").fetchone()[0], 0)

    def test_the_audit_row_has_no_free_text_column(self):
        columns = [row[1] for row in self.db.execute("PRAGMA table_info(audit_events)")]
        self.assertEqual(sorted(columns), sorted(["id", "org_id", "actor_user_id", "action", "target_type", "target_id", "outcome", "created_at"]))


if __name__ == "__main__":
    unittest.main()

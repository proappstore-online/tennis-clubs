import importlib.util
import json
import re
import subprocess
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TOOLS = {tool["name"]: tool for tool in json.loads((ROOT / "mcp.json").read_text())["tools"]}

_spec = importlib.util.spec_from_file_location("render_mcp_catalog", ROOT / "scripts" / "render_mcp_catalog.py")
renderer = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(renderer)

IDEMPOTENCY = {"read-only", "idempotent", "not-idempotent", "append-only"}
AUDIENCES = {"manager", "admin", "player", "member", "invitee", "creator", "self"}
PRIVATE_FIELDS = {"convenor_phone", "contact", "scorecard_path", "scorecard_user_id", "submitted_by", "invite_token", "actor_user_id", "email"}
PLAYER_AUDIENCES = {"player", "invitee", "self"}
SELF_RECORDED_AUDIENCES = {"creator", "invitee", "self"}
CONTRACT_KEYS = {"access", "roles", "audience", "idempotency", "audit", "paging", "versioned", "redacts"}


def gate_roles(sql):
    roles = set()
    for group in re.findall(r"cm\.role IN \(([^)]*)\)", sql):
        roles.update(part.strip().strip("'") for part in group.split(","))
    return sorted(roles)


class McpContractTests(unittest.TestCase):
    def test_every_action_declares_a_complete_contract(self):
        for name, tool in TOOLS.items():
            with self.subTest(action=name):
                self.assertEqual(set(tool["contract"]), CONTRACT_KEYS)
                self.assertIn(tool["contract"]["idempotency"], IDEMPOTENCY)
                self.assertIn(tool["contract"]["audience"], AUDIENCES)
                self.assertIs(tool.get("requires_auth"), True)
                self.assertIn(tool["operation"], {"query", "execute"})

    def test_declared_roles_are_exactly_the_sql_club_gate(self):
        for name, tool in TOOLS.items():
            with self.subTest(action=name):
                self.assertEqual(tool["contract"]["roles"], gate_roles(tool["sql"]))
                if tool["contract"]["roles"]:
                    self.assertIn("cm.is_active=1", tool["sql"].replace(" ", ""))
                    self.assertIn(":__user_id", tool["sql"])

    def test_convenor_is_a_manager_role_in_every_club_gate(self):
        for name, tool in TOOLS.items():
            if tool["contract"]["roles"] and tool["contract"]["roles"] != ["admin"]:
                with self.subTest(action=name):
                    self.assertIn("convenor", tool["contract"]["roles"])
                    self.assertIn("manager", tool["contract"]["roles"])

    def test_idempotency_matches_statement_shape(self):
        for name, tool in TOOLS.items():
            sql = tool["sql"]
            mode = tool["contract"]["idempotency"]
            with self.subTest(action=name, idempotency=mode):
                main = re.search(r"\b(INSERT INTO|UPDATE|DELETE FROM)\b", sql)
                if mode == "read-only":
                    self.assertEqual(tool["operation"], "query")
                elif mode == "idempotent":
                    self.assertEqual(tool["operation"], "execute")
                    self.assertTrue(main and ("ON CONFLICT" in sql[main.start():] or main.group(1) in ("UPDATE", "DELETE FROM")), sql[:80])
                else:
                    self.assertEqual(tool["operation"], "execute")
                    self.assertTrue(main and main.group(1) == "INSERT INTO", sql[:80])
                    self.assertNotIn("ON CONFLICT", sql[main.start():])

    def test_list_actions_page_with_bounded_limit_offset_and_stable_order(self):
        for name, tool in TOOLS.items():
            if not name.startswith("list_"):
                continue
            with self.subTest(action=name):
                self.assertTrue(tool["contract"]["paging"])
                limit, offset = tool["params"]["limit"], tool["params"]["offset"]
                self.assertEqual((limit["min"], limit["max"]), (1, 100))
                self.assertEqual(offset["min"], 0)
                self.assertTrue(tool["sql"].endswith("LIMIT :limit OFFSET :offset"), tool["sql"][-60:])
                order = tool["sql"][tool["sql"].rindex("ORDER BY"):]
                self.assertIn(",", order, "ordering needs a unique tie-break key")

    def test_versioned_reads_return_updated_at(self):
        for name, tool in TOOLS.items():
            if tool["contract"]["versioned"]:
                with self.subTest(action=name):
                    self.assertIn("updated_at", renderer.returns(tool, renderer.load()[1]))

    def test_redacted_fields_are_absent_from_responses(self):
        db = renderer.load()[1]
        for name, tool in TOOLS.items():
            if tool["operation"] != "query":
                continue
            columns = set(renderer.returns(tool, db))
            with self.subTest(action=name):
                self.assertEqual(columns & set(tool["contract"]["redacts"]), set())

    def test_player_facing_responses_never_include_private_fields(self):
        db = renderer.load()[1]
        for name, tool in TOOLS.items():
            if tool["operation"] != "query" or tool["contract"]["audience"] not in PLAYER_AUDIENCES:
                continue
            with self.subTest(action=name):
                self.assertEqual(set(renderer.returns(tool, db)) & PRIVATE_FIELDS, set())

    def test_audit_allowlist_is_exactly_the_audited_writes(self):
        audited = {name for name, tool in TOOLS.items() if tool["contract"]["audit"]}
        allowlist = set(re.findall(r"'([a-z_]+)'", TOOLS["record_audit_event"]["sql"].split("WHERE :action IN (")[1].split(")")[0]))
        self.assertEqual(allowlist, audited)
        for name in audited:
            with self.subTest(action=name):
                self.assertEqual(TOOLS[name]["operation"], "execute")

    def test_audit_action_enum_matches_the_audited_writes(self):
        audited = sorted(name for name, tool in TOOLS.items() if tool["contract"]["audit"])
        self.assertEqual(sorted(TOOLS["record_audit_event"]["params"]["action"]["enum"]), audited)

    def test_every_write_is_audited_or_recorded_as_append_only(self):
        for name, tool in TOOLS.items():
            if tool["operation"] == "execute" and not tool["contract"]["audit"]:
                with self.subTest(action=name):
                    recorded_by_itself = name.startswith("record_") or tool["contract"]["idempotency"] == "append-only"
                    if name == "set_my_fixture_availability":
                        self.assertIn("log_my_fixture_availability_change", TOOLS)
                    else:
                        self.assertTrue(recorded_by_itself or tool["contract"]["audience"] in SELF_RECORDED_AUDIENCES, name)

    def test_declared_bounds_and_enums_are_well_formed(self):
        for name, tool in TOOLS.items():
            for param, spec in tool.get("params", {}).items():
                with self.subTest(action=name, param=param):
                    if "min" in spec and "max" in spec:
                        self.assertLessEqual(spec["min"], spec["max"])
                    if "enum" in spec:
                        self.assertTrue(spec["enum"])
                        self.assertEqual(len(spec["enum"]), len(set(spec["enum"])))

    def test_generated_contract_docs_and_catalog_are_current(self):
        result = subprocess.run(
            [sys.executable, str(ROOT / "scripts" / "render_mcp_catalog.py"), "--check"],
            capture_output=True, text=True,
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_docs_describe_every_action(self):
        doc = (ROOT / "docs" / "mcp-contract.md").read_text(encoding="utf-8")
        for name in TOOLS:
            with self.subTest(action=name):
                self.assertIn(f"### `{name}`", doc)


if __name__ == "__main__":
    unittest.main()

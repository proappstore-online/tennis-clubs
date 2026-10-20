import json
import re
import sqlite3
import unittest
from pathlib import Path

from mcp_harness import connect
from test_mcp_permissions import SEED

# Caller scope for every Tennis Clubs MCP action (issue #8). Each action binds the authenticated caller (:__user_id),
# and an action that takes an org_id also binds that club. An action with no club-role gate must appear in JUSTIFIED,
# with the scope it relies on; docs/mcp-caller-scope.md describes the same classes.
ROOT = Path(__file__).resolve().parents[1]
MIGRATIONS = json.loads((ROOT / "migrations.json").read_text())["migrations"]
TOOLS = {tool["name"]: tool for tool in json.loads((ROOT / "mcp.json").read_text())["tools"]}
DOC = (ROOT / "docs" / "mcp-caller-scope.md").read_text(encoding="utf-8")

# Actions that deliberately carry no club-role gate, the scope they rely on, and why. A new action with an empty
# roles list fails test_every_action_without_a_club_role_gate_is_justified until it is listed here with a reason.
JUSTIFIED = {
    "list_my_fixtures": ("team", "fixtures of teams the caller belongs to through team_players or an accepted team_memberships row"),
    "list_fixture_roster": ("team", "a fixture's roster, for a member of one of its two teams, in its own club"),
    "set_my_fixture_availability": ("self", "writes only the caller's own roster row"),
    "log_my_fixture_availability_change": ("self", "logs only the caller's own availability change"),
    "can_create_first_club": ("self", "reports whether the caller may create a first club, and any club the caller created that still awaits setup"),
    "create_club": ("creator", "a user with no membership and no club created by them may create one; the creator is the caller"),
    "bootstrap_club_admin": ("creator", "the creator of a club claims its first administrator role, only while the caller holds no other membership"),
    "accept_team_invite": ("invite-token", "a single-use invitation token binds the caller as the invited member; the caller is not yet a member of any club"),
    "activate_invited_club_membership": ("invite-token", "the same single-use token creates the caller's club membership for the invited club"),
    "get_club": ("member", "a club's name and slug, for an active member of that club"),
    "list_external_clubs": ("member", "opponent clubs of a club, read-only, for an active member of that club"),
    "list_my_clubs": ("member", "the caller's own active club memberships"),
}

# The scope each justified class relies on, checked against the SQL. A class whose SQL does not match fails.
SCOPE_CHECKS = {
    "team": lambda sql: "team_players" in sql and ":__user_id" in sql,
    "self": lambda sql: ":__user_id" in sql,
    "creator": lambda sql: "created_by=:__user_id" in sql.replace(" ", ""),
    "invite-token": lambda sql: ":claim_token" in sql and "user_id IS NULL" in sql,
    "member": lambda sql: "club_memberships" in sql and ":__user_id" in sql and "is_active=1" in sql.replace(" ", ""),
}

# Actions whose SQL does not bind the caller. None exist; an entry here would need a written reason.
UNSCOPED = {}

# String parameters that carry JSON documents, so the sweep can pass a valid empty document.
JSON_PARAMS = {"payload", "issues", "outcomes", "rows", "archive", "set_results"}


def club_gate_roles(tool):
    return tool["contract"]["roles"]


class McpCallerScopeTests(unittest.TestCase):
    def setUp(self):
        self.db = connect()
        self.db.row_factory = sqlite3.Row
        for migration in MIGRATIONS:
            self.db.executescript(migration["sql"])
        self.db.executescript(SEED)

    def tearDown(self):
        self.db.close()

    def test_no_action_leaves_the_caller_unbound(self):
        unbound = sorted(name for name, tool in TOOLS.items() if ":__user_id" not in tool["sql"])
        self.assertEqual(unbound, sorted(UNSCOPED))
        for name, reason in UNSCOPED.items():
            self.assertTrue(reason.strip(), f"{name} needs a reason to be unscoped")

    def test_every_action_without_a_club_role_gate_is_justified(self):
        open_actions = sorted(name for name, tool in TOOLS.items() if not club_gate_roles(tool))
        self.assertEqual(open_actions, sorted(JUSTIFIED), "list every ungated action in JUSTIFIED, and only those")
        for name, (scope, reason) in JUSTIFIED.items():
            with self.subTest(action=name):
                self.assertIn(scope, SCOPE_CHECKS)
                self.assertTrue(reason.strip())
                self.assertTrue(SCOPE_CHECKS[scope](TOOLS[name]["sql"]), f"{name} does not match its {scope} scope")

    def test_org_scoped_actions_bind_both_the_club_and_the_caller(self):
        for name, tool in TOOLS.items():
            if "org_id" in tool.get("params", {}):
                with self.subTest(action=name):
                    self.assertIn(":org_id", tool["sql"])
                    self.assertIn(":__user_id", tool["sql"])

    def test_no_outsider_or_other_club_manager_reads_another_clubs_data(self):
        # Callers with no relation to club a: a manager of club b, and a signed-in user who belongs to nothing.
        ids = {"fixture_id": "fa", "team_id": "ta", "user_id": "play-a", "season_id": "sa", "venue_id": "va", "import_run_id": "imp-a",
               "document_id": "doc-a", "external_club_id": "ec-a", "submission_id": "sub-a", "limit": 100, "offset": 0, "from": "2000-01-01"}
        leaks = []
        for name, tool in TOOLS.items():
            if tool["operation"] != "query" or "org_id" not in tool.get("params", {}):
                continue
            for caller in ["mgr-b", "outsider"]:
                params = {key: ("[]" if key in JSON_PARAMS else ids.get(key, "")) for key in tool.get("params", {})}
                params["org_id"] = "a"
                rows = self.db.execute(tool["sql"], {"__user_id": caller, "__now": 1000, **params}).fetchall()
                if rows:
                    leaks.append((name, caller, len(rows)))
        self.assertEqual(leaks, [])

    def test_a_team_member_sees_only_their_own_squad_row(self):
        rows = self.db.execute(TOOLS["list_team_pool"]["sql"], {"__user_id": "play-b", "__now": 1000, "org_id": "a", "team_id": "ta", "limit": 100, "offset": 0}).fetchall()
        self.assertEqual([row["user_id"] for row in rows], ["play-b"])

    def test_a_pending_invitation_binds_only_the_first_caller_who_claims_it(self):
        accept = TOOLS["accept_team_invite"]["sql"]
        self.assertEqual(self.db.execute(accept, {"__user_id": "newbie", "__now": 1000, "claim_token": "tok-pending", "display_name": "Newbie"}).rowcount, 1)
        self.assertEqual(self.db.execute(accept, {"__user_id": "other", "__now": 1000, "claim_token": "tok-pending", "display_name": "Other"}).rowcount, 0)
        self.assertEqual(self.db.execute("SELECT user_id FROM team_memberships WHERE id='tm-pending'").fetchone()[0], "newbie")

    def test_the_contract_docs_describe_every_scope_and_justified_action(self):
        for scope in SCOPE_CHECKS:
            self.assertIn(f"`{scope}`", DOC)
        for name in JUSTIFIED:
            self.assertIn(f"`{name}`", DOC)


if __name__ == "__main__":
    unittest.main()

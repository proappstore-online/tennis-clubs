import json
import sqlite3
import unittest
from datetime import datetime, timezone
from pathlib import Path

from mcp_harness import connect

ROOT = Path(__file__).resolve().parents[1]
MIGRATIONS = json.loads((ROOT / "migrations.json").read_text())["migrations"]
TOOLS = {tool["name"]: tool for tool in json.loads((ROOT / "mcp.json").read_text())["tools"]}
NOW = int(datetime(2026, 10, 12, tzinfo=timezone.utc).timestamp() * 1000)
SHA = "a" * 64

SEED = """
INSERT INTO organizations(id,name,slug,created_at,created_by) VALUES ('a','Club A','club-a',1,'founder-a'),('b','Club B','club-b',1,'founder-b');
INSERT INTO club_memberships(id,org_id,user_id,role,display_name,is_active,created_at) VALUES
  ('m1','a','adm-a','admin','Admin A',1,1),
  ('m2','a','mgr-a','manager','Manager A',1,1),
  ('m3','a','conv-a','convenor','Convenor A',1,1),
  ('m4','a','play-a','player','Player A',1,1),
  ('m5','a','par-a','parent','Parent A',1,1),
  ('m6','a','inact-a','manager','Inactive A',0,1),
  ('m7','b','mgr-b','manager','Manager B',1,1);
INSERT INTO seasons(id,org_id,name,starts_on,ends_on,status,created_at) VALUES ('sa','a','2026','2026-01-01','2026-12-31','upcoming',1);
INSERT INTO divisions(id,season_id,name,format,created_at) VALUES ('da','sa','Div A',NULL,1);
INSERT INTO teams(id,org_id,division_id,name,colour,created_at,is_external) VALUES ('ta','a','da','Northside',NULL,1,0),('tb','a','da','Lakeside',NULL,1,0);
INSERT INTO team_memberships(id,org_id,team_id,user_id,display_name,invite_token,created_by,accepted_at,created_at) VALUES ('tm1','a','ta','play-a','Player A',NULL,'mgr-a',1,1);
"""

USERS = ["outsider", "mgr-b", "inact-a", "play-a", "par-a", "mgr-a", "conv-a", "adm-a"]
DOCS = {
    "pub": ("public", None),
    "mem": ("member", None),
    "tm": ("team", "ta"),
    "mgr": ("manager", None),
    "adm": ("admin", None),
}
EXPECTED = {
    "pub": {"outsider", "mgr-b", "inact-a", "play-a", "par-a", "mgr-a", "conv-a", "adm-a"},
    "mem": {"play-a", "par-a", "mgr-a", "conv-a", "adm-a"},
    "tm": {"play-a", "mgr-a", "conv-a", "adm-a"},
    "mgr": {"mgr-a", "conv-a", "adm-a"},
    "adm": {"adm-a"},
}


class DocumentLibraryTests(unittest.TestCase):
    def setUp(self):
        self.db = connect()
        self.db.row_factory = sqlite3.Row
        for migration in MIGRATIONS:
            self.db.executescript(migration["sql"])
        self.db.executescript(SEED)
        for doc_id, (visibility, team) in DOCS.items():
            actor = "adm-a" if visibility == "admin" else "mgr-a"
            self.assertEqual(self.register(actor, doc_id, visibility=visibility, team_id=team).rowcount, 1)
            self.assertEqual(self.run_action("mark_document_stored", actor, org_id="a", document_id=doc_id, storage_key=f"docs/a/{doc_id}",
                                             content_type="application/pdf", byte_size=1024, sha256=SHA).rowcount, 1)

    def tearDown(self):
        self.db.close()

    def run_action(self, tool, user, **params):
        return self.db.execute(TOOLS[tool]["sql"], {"__user_id": user, "__now": NOW, **params})

    def rows(self, tool, user, **params):
        return [dict(row) for row in self.run_action(tool, user, **params).fetchall()]

    def register(self, user, doc_id, visibility="member", team_id=None, **overrides):
        values = {"id": doc_id, "org_id": "a", "scope_type": "club", "scope_id": "a", "team_id": team_id,
                  "title": f"Guide {doc_id}", "description": "General guidance", "category": "guidance",
                  "visibility": visibility, "source_attribution": "Club committee", "effective_on": "2026-03-01",
                  "revision": "v1", "expires_on": None, "content_type": "application/pdf", "byte_size": 1024, "sha256": SHA, **overrides}
        return self.run_action("register_document", user, **values)

    def visible_to(self, doc_id):
        return {user for user in USERS if any(row["id"] == doc_id for row in self.rows("list_documents", user, org_id="a"))}

    def test_visibility_levels_match_the_expected_audience_for_every_user(self):
        for doc_id, audience in EXPECTED.items():
            with self.subTest(document=doc_id):
                self.assertEqual(self.visible_to(doc_id), audience)

    def test_download_authorisation_agrees_with_the_listing(self):
        for doc_id in DOCS:
            for user in USERS:
                with self.subTest(document=doc_id, user=user):
                    granted = bool(self.rows("check_document_access", user, org_id="a", document_id=doc_id))
                    self.assertEqual(granted, user in EXPECTED[doc_id])

    def test_registration_is_limited_to_managers_and_their_own_visibility_levels(self):
        for user in ("play-a", "par-a", "mgr-b", "outsider", "inact-a"):
            with self.subTest(user=user):
                self.assertEqual(self.register(user, f"new-{user}").rowcount, 0)
        self.assertEqual(self.register("mgr-a", "new-admin", visibility="admin").rowcount, 0)
        self.assertEqual(self.register("adm-a", "new-admin", visibility="admin").rowcount, 1)
        self.assertEqual(self.register("mgr-a", "new-team", visibility="team", team_id=None).rowcount, 0)
        self.assertEqual(self.register("mgr-a", "new-team-b", visibility="team", team_id="tb").rowcount, 1)
        self.assertEqual(self.register("mgr-a", "bad-sha", sha256="xyz").rowcount, 0)
        self.assertEqual(self.register("mgr-a", "bad-category", category="gossip").rowcount, 0)
        self.assertEqual(self.register("mgr-a", "bad-scope", scope_type="team", scope_id="tc").rowcount, 0)
        self.assertEqual(self.register("mgr-a", "bad-dates", expires_on="2025-01-01").rowcount, 0)
        self.assertEqual(self.register("mgr-a", "too-big", byte_size=10485761).rowcount, 0)

    def test_managers_cannot_change_admin_documents_or_raise_visibility_above_their_level(self):
        self.assertEqual(self.run_action("change_document_visibility", "mgr-a", org_id="a", document_id="adm", visibility="public").rowcount, 0)
        self.assertEqual(self.run_action("update_document_details", "mgr-a", org_id="a", document_id="adm", title="Changed", description="", category="guidance",
                                         source_attribution="Committee", revision="v2", effective_on="2026-03-01", expires_on=None).rowcount, 0)
        self.assertEqual(self.run_action("change_document_visibility", "mgr-a", org_id="a", document_id="mem", visibility="manager").rowcount, 1)
        self.assertEqual(self.run_action("change_document_visibility", "mgr-a", org_id="a", document_id="mem", visibility="admin").rowcount, 0)
        self.assertEqual(self.run_action("change_document_visibility", "adm-a", org_id="a", document_id="adm", visibility="public").rowcount, 1)
        self.assertIn("outsider", self.visible_to("adm"))

    def test_non_managers_cannot_change_withdraw_or_store_documents(self):
        for user in ("play-a", "par-a", "mgr-b", "outsider"):
            with self.subTest(user=user):
                self.assertEqual(self.run_action("change_document_visibility", user, org_id="a", document_id="mem", visibility="public").rowcount, 0)
                self.assertEqual(self.run_action("withdraw_document", user, org_id="a", document_id="mem").rowcount, 0)
                self.assertEqual(self.run_action("update_document_details", user, org_id="a", document_id="mem", title="x", description="", category="guidance",
                                                 source_attribution="x", revision="v2", effective_on="2026-03-01", expires_on=None).rowcount, 0)
        self.assertEqual(self.register("mgr-a", "pending-doc").rowcount, 1)
        self.assertEqual(self.run_action("mark_document_stored", "play-a", org_id="a", document_id="pending-doc", storage_key="k", content_type="application/pdf",
                                         byte_size=1, sha256=SHA).rowcount, 0)

    def test_withdrawn_and_expired_documents_disappear_for_everyone(self):
        self.assertEqual(self.run_action("withdraw_document", "mgr-a", org_id="a", document_id="pub").rowcount, 1)
        self.assertNotIn("pub", self.visible_to("pub"))
        self.assertEqual(self.rows("check_document_access", "adm-a", org_id="a", document_id="pub"), [])
        self.assertEqual(self.run_action("change_document_visibility", "mgr-a", org_id="a", document_id="pub", visibility="member").rowcount, 0)
        self.register("mgr-a", "expired", expires_on="2026-10-01")
        self.run_action("mark_document_stored", "mgr-a", org_id="a", document_id="expired", storage_key="k", content_type="application/pdf", byte_size=1, sha256=SHA)
        self.assertNotIn("expired", {row["id"] for row in self.rows("list_documents", "adm-a", org_id="a")})
        self.register("mgr-a", "current", expires_on="2027-01-01")
        self.run_action("mark_document_stored", "mgr-a", org_id="a", document_id="current", storage_key="k", content_type="application/pdf", byte_size=1, sha256=SHA)
        self.assertIn("current", {row["id"] for row in self.rows("list_documents", "mgr-a", org_id="a")})

    def test_a_stored_file_must_match_its_registered_hash_and_is_stored_once(self):
        self.register("mgr-a", "hashed")
        self.assertEqual(self.run_action("mark_document_stored", "mgr-a", org_id="a", document_id="hashed", storage_key="k", content_type="application/pdf",
                                         byte_size=1, sha256="b" * 64).rowcount, 0)
        self.assertEqual(self.run_action("mark_document_stored", "mgr-a", org_id="a", document_id="hashed", storage_key="k", content_type="application/pdf",
                                         byte_size=1, sha256=SHA).rowcount, 1)
        self.assertEqual(self.run_action("mark_document_stored", "mgr-a", org_id="a", document_id="hashed", storage_key="k", content_type="application/pdf",
                                         byte_size=1, sha256=SHA).rowcount, 0)

    def test_listings_never_reveal_storage_keys_or_uploaders(self):
        rows = self.rows("list_documents", "adm-a", org_id="a")
        self.assertTrue(rows)
        serialised = json.dumps(rows)
        self.assertNotIn("docs/a/", serialised)
        self.assertNotIn("uploaded_by", rows[0])
        self.assertNotIn("storage_key", rows[0])

    def test_metadata_records_attribution_revision_and_expiry(self):
        row = self.rows("list_documents", "mgr-a", org_id="a", query="mem")[0]
        self.assertEqual((row["source_attribution"], row["revision"], row["effective_on"], row["expires_on"], row["visibility"]), ("Club committee", "v1", "2026-03-01", None, "member"))

    def test_history_and_access_logs_are_manager_only_and_record_the_actor(self):
        self.run_action("change_document_visibility", "mgr-a", org_id="a", document_id="mem", visibility="manager")
        self.run_action("log_document_change", "mgr-a", id="h1", org_id="a", document_id="mem", action="visibility_changed", old_visibility="member")
        history = self.rows("list_document_history", "mgr-a", org_id="a", document_id="mem")
        self.assertEqual([(row["action"], row["actor_user_id"]) for row in history], [("visibility_changed", "mgr-a")])
        self.assertEqual(self.rows("list_document_history", "play-a", org_id="a", document_id="mem"), [])
        self.assertEqual(self.run_action("log_document_access", "play-a", id="x1", org_id="a", document_id="tm", action="download").rowcount, 1)
        self.assertEqual(self.run_action("log_document_access", "par-a", id="x2", org_id="a", document_id="adm", action="download").rowcount, 1)
        log = self.rows("list_document_access_log", "mgr-a", org_id="a", document_id="adm")
        self.assertEqual([(row["actor_user_id"], row["outcome"]) for row in log], [("par-a", "denied")])
        log = self.rows("list_document_access_log", "mgr-a", org_id="a", document_id="tm")
        self.assertEqual([(row["actor_user_id"], row["outcome"]) for row in log], [("play-a", "allowed")])
        self.assertEqual(self.rows("list_document_access_log", "play-a", org_id="a", document_id="tm"), [])

    def test_a_non_member_cannot_forge_an_allowed_access_entry(self):
        attempts = [("outsider", "mem"), ("inact-a", "mgr"), ("par-a", "mgr"), ("play-a", "adm")]
        for user, doc_id in attempts:
            with self.subTest(user=user, document=doc_id):
                # The outcome parameter is not part of the action; a forged value must be ignored.
                self.assertEqual(self.run_action("log_document_access", user, id=f"forge-{user}-{doc_id}", org_id="a", document_id=doc_id,
                                                 action="download", outcome="allowed").rowcount, 1)
                row = self.db.execute("SELECT outcome FROM document_access_log WHERE id=?", (f"forge-{user}-{doc_id}",)).fetchone()
                self.assertEqual(row["outcome"], "denied")
        # A manager of another club may append a denied attempt for a known id, but never an allowed one.
        self.assertEqual(self.run_action("log_document_access", "mgr-b", id="cross", org_id="a", document_id="mem", action="download").rowcount, 1)
        self.assertEqual(self.db.execute("SELECT outcome FROM document_access_log WHERE id='cross'").fetchone()["outcome"], "denied")

    def test_access_log_outcome_agrees_with_download_authorisation(self):
        for doc_id in DOCS:
            for user in USERS:
                with self.subTest(document=doc_id, user=user):
                    granted = bool(self.rows("check_document_access", user, org_id="a", document_id=doc_id))
                    entry = f"parity-{doc_id}-{user}"
                    self.run_action("log_document_access", user, id=entry, org_id="a", document_id=doc_id, action="view")
                    outcome = self.db.execute("SELECT outcome FROM document_access_log WHERE id=?", (entry,)).fetchone()["outcome"]
                    self.assertEqual(outcome, "allowed" if granted else "denied")

    def test_an_unstored_document_download_is_logged_as_denied(self):
        # A registered document has no file, so the download is answered with a 404 and nothing is served; the log must not say it was allowed.
        self.assertEqual(self.register("mgr-a", "unstored", visibility="member").rowcount, 1)
        self.assertEqual(self.rows("check_document_access", "play-a", org_id="a", document_id="unstored"), [])
        self.run_action("log_document_access", "play-a", id="unstored-try", org_id="a", document_id="unstored", action="download")
        self.assertEqual(self.db.execute("SELECT outcome FROM document_access_log WHERE id='unstored-try'").fetchone()["outcome"], "denied")

    def test_search_category_and_paging_work_within_visibility(self):
        self.register("mgr-a", "handbook", category="behaviour", visibility="member", title="Parent behaviour handbook")
        self.run_action("mark_document_stored", "mgr-a", org_id="a", document_id="handbook", storage_key="k", content_type="application/pdf", byte_size=1, sha256=SHA)
        found = self.rows("list_documents", "play-a", org_id="a", query="behaviour")
        self.assertEqual([row["id"] for row in found], ["handbook"])
        self.assertEqual(self.rows("list_documents", "outsider", org_id="a", query="behaviour"), [])
        self.assertEqual(self.rows("list_documents", "play-a", org_id="a", category="roster"), [])
        page_one = [row["id"] for row in self.rows("list_documents", "adm-a", org_id="a", limit=2, offset=0)]
        page_two = [row["id"] for row in self.rows("list_documents", "adm-a", org_id="a", limit=2, offset=2)]
        self.assertEqual(len(page_one), 2)
        self.assertFalse(set(page_one) & set(page_two))

    def test_documents_are_scoped_to_their_club(self):
        self.assertEqual(self.register("mgr-b", "cross").rowcount, 0)
        self.assertEqual([row["id"] for row in self.rows("list_documents", "mgr-b", org_id="a")], ["pub"])
        self.assertEqual(self.run_action("withdraw_document", "mgr-b", org_id="a", document_id="mem").rowcount, 0)

    def test_members_see_only_their_own_clubs(self):
        self.assertEqual([row["id"] for row in self.rows("list_my_clubs", "play-a")], ["a"])
        self.assertEqual(self.rows("list_my_clubs", "outsider"), [])
        self.assertEqual([row["id"] for row in self.rows("list_my_clubs", "mgr-b")], ["b"])
        self.assertEqual(self.rows("list_my_clubs", "inact-a"), [])

    def test_document_actions_are_audited_or_recorded_as_appends(self):
        for name in ("register_document", "update_document_details", "change_document_visibility", "withdraw_document", "mark_document_stored"):
            with self.subTest(action=name):
                self.assertTrue(TOOLS[name]["contract"]["audit"])
        for name in ("log_document_change", "log_document_access"):
            with self.subTest(action=name):
                self.assertEqual(TOOLS[name]["contract"]["idempotency"], "append-only")
        select_clause = TOOLS["list_documents"]["sql"].split(" FROM documents", 1)[0]
        self.assertNotIn("storage_key", select_clause)
        self.assertNotIn("uploaded_by", select_clause)


if __name__ == "__main__":
    unittest.main()

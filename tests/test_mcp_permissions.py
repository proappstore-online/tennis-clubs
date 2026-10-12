import json
import sqlite3
import unittest
from pathlib import Path

from mcp_harness import connect

ROOT = Path(__file__).resolve().parents[1]
MIGRATIONS = json.loads((ROOT / "migrations.json").read_text())["migrations"]
TOOLS = {tool["name"]: tool for tool in json.loads((ROOT / "mcp.json").read_text())["tools"]}

SEED = """
INSERT INTO organizations(id,name,slug,created_at,created_by) VALUES ('a','Club A','club-a',1,'founder-a'),('b','Club B','club-b',1,'founder-b');
INSERT INTO club_memberships(id,org_id,user_id,role,display_name,is_active,created_at) VALUES
  ('m1','a','adm-a','admin','Admin A',1,1),
  ('m2','a','conv-a','convenor','Convenor A',1,1),
  ('m3','a','mgr-a','manager','Manager A',1,1),
  ('m4','a','play-a','player','Player A',1,1),
  ('m5','a','par-a','parent','Parent A',1,1),
  ('m6','a','inact-a','manager','Inactive A',0,1),
  ('m7','b','mgr-b','manager','Manager B',1,1),
  ('m8','b','conv-b','convenor','Convenor B',1,1);
INSERT INTO seasons(id,org_id,name,starts_on,ends_on,status,created_at) VALUES ('sa','a','Season A','2026-01-01','2026-12-31','upcoming',1),('sb','b','Season B','2026-01-01','2026-12-31','upcoming',1);
INSERT INTO divisions(id,season_id,name,format,created_at) VALUES ('da','sa','Div A',NULL,1),('db','sb','Div B',NULL,1);
INSERT INTO teams(id,org_id,division_id,name,colour,created_at) VALUES ('ta','a','da','Team A',NULL,1),('tb','a','da','Team B',NULL,1),('tc','b','db','Team C',NULL,1),('td','b','db','Team D',NULL,1);
INSERT INTO venues(id,org_id,name,address,map_url,notes,convenor_phone,created_at) VALUES ('va','a','Courts A','1 Rd','https://maps.example/a','Gate','0400000001',1),('vb','b','Courts B',NULL,NULL,NULL,'0400000002',1);
INSERT INTO fixtures(id,org_id,division_id,home_team_id,away_team_id,venue_id,starts_at,round_label,status,created_at) VALUES ('fa','a','da','ta','tb','va','2026-10-11T09:00:00+11:00','R1','scheduled',1),('fb','b','db','tc','td','vb','2026-10-11T09:00:00+11:00','R1','scheduled',1);
INSERT INTO team_memberships(id,org_id,team_id,user_id,display_name,invite_token,created_by,accepted_at,created_at) VALUES
  ('tm1','a','ta','play-a','Player A',NULL,'mgr-a',1,1),
  ('tm2','a','ta','play-b','Player B',NULL,'mgr-a',1,1),
  ('tm-pending','a','ta',NULL,'Invited','tok-pending','mgr-a',NULL,1);
INSERT INTO fixture_roster(fixture_id,user_id,display_name,availability,confirmed_at) VALUES ('fa','play-a','Player A','pending',1);
INSERT INTO fixture_result_submissions(id,fixture_id,submitted_by,home_score,away_score,set_results,scorecard_user_id,scorecard_path,submitted_at,correction_note) VALUES
  ('sub-a','fa','conv-a',3,1,'','conv-a','fixture-cards/fa/card.pdf',5,NULL),
  ('sub-b','fb','mgr-b',0,2,'','mgr-b','fixture-cards/fb/card.pdf',5,NULL);
INSERT INTO import_runs(id,org_id,actor_user_id,kind,received_count,saved_count,rejected_count,status,created_at) VALUES ('imp-a','a','conv-a','fixtures',3,3,0,'saved',5);
INSERT INTO audit_events(id,org_id,actor_user_id,action,target_type,target_id,outcome,created_at) VALUES ('aud-a','a','conv-a','update_venue','venue','va','succeeded',5);
"""

NON_MANAGERS = ["play-a", "par-a", "inact-a", "mgr-b", "conv-b", "outsider"]

MANAGER_WRITES = {
    "create_season": {"id": "s-new", "org_id": "a", "name": "Season 2", "starts_on": "2027-01-01", "ends_on": "2027-12-31", "status": "upcoming"},
    "create_division": {"id": "d-new", "season_id": "sa", "name": "Div 2", "format": "singles"},
    "create_venue": {"id": "v-new", "org_id": "a", "name": "Hall", "address": "", "map_url": "", "notes": "", "convenor_phone": ""},
    "update_venue": {"venue_id": "va", "org_id": "a", "name": "Courts A2", "address": "", "map_url": "", "notes": "", "convenor_phone": "0400000009"},
    "create_team": {"id": "t-new", "org_id": "a", "division_id": "da", "name": "Team E", "colour": ""},
    "create_team_invite": {"id": "inv-new", "team_id": "ta", "invite_token": "tok-new"},
    "upsert_imported_fixture": {"id": "f-new", "org_id": "a", "home_team_id": "ta", "away_team_id": "tb", "venue_id": "va", "starts_at": "2026-11-01T09:00:00+11:00", "round_label": "R2", "season": "Season A"},
    "upsert_imported_roster_player": {"id": "rp-new", "org_id": "a", "starts_at": "2026-10-11T09:00:00+11:00", "round_label": "R1", "team": "Team A", "opponent": "Team B", "player_name": "Sam", "contact": "0400"},
    "add_fixture_roster_player": {"fixture_id": "fa", "user_id": "play-b"},
    "log_fixture_roster_added": {"fixture_id": "fa", "user_id": "play-b"},
    "remove_fixture_roster_player": {"fixture_id": "fa", "user_id": "play-a"},
    "update_fixture_match_day": {"fixture_id": "fa", "status": "washout", "match_notice": "Rain"},
    "submit_fixture_result": {"id": "sub-new", "fixture_id": "fa", "home_score": 2, "away_score": 1, "set_results": "", "scorecard_user_id": None, "scorecard_path": None, "correction_note": ""},
    "apply_fixture_result_to_fixture": {"submission_id": "sub-a", "fixture_id": "fa"},
    "record_import_run": {"id": "imp-new", "org_id": "a", "kind": "fixtures", "received_count": 3, "saved_count": 3, "rejected_count": 0, "status": "saved"},
    "record_audit_event": {"id": "aud-new", "org_id": "a", "action": "update_venue", "target_type": "venue", "target_id": "va", "outcome": "succeeded"},
}
MANAGER_WRITE_DENIALS_ONLY = {
    "log_fixture_roster_removed": {"fixture_id": "fa", "user_id": "play-x", "old_availability": "pending"},
}


def ids(rows, key="id"):
    return sorted(row[key] for row in rows)


class McpPermissionTests(unittest.TestCase):
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

    def rows(self, tool, user, **params):
        return [dict(row) for row in self.run_action(tool, user, **params).fetchall()]

    def test_non_managers_and_other_clubs_cannot_change_manager_records(self):
        for action, params in {**MANAGER_WRITES, **MANAGER_WRITE_DENIALS_ONLY}.items():
            for user in NON_MANAGERS:
                with self.subTest(action=action, user=user):
                    self.assertEqual(self.run_action(action, user, **params).rowcount, 0)
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM seasons").fetchone()[0], 2)
        self.assertEqual(self.db.execute("SELECT name FROM venues WHERE id='va'").fetchone()[0], "Courts A")

    def test_convenor_completes_every_manager_write_in_own_club(self):
        for action, params in MANAGER_WRITES.items():
            with self.subTest(action=action):
                self.assertEqual(self.run_action(action, "conv-a", **params).rowcount, 1)
        self.assertEqual(self.db.execute("SELECT status FROM fixtures WHERE id='fa'").fetchone()[0], "complete")
        self.assertEqual(self.db.execute("SELECT updated_at FROM fixtures WHERE id='fa'").fetchone()[0], 1000)

    def test_inactive_admin_membership_is_denied_every_manager_write(self):
        self.db.execute("UPDATE club_memberships SET is_active=0 WHERE user_id='adm-a'")
        for action, params in MANAGER_WRITES.items():
            with self.subTest(action=action):
                self.assertEqual(self.run_action(action, "adm-a", **params).rowcount, 0)

    def test_player_and_parent_writes_are_limited_to_their_own_rows(self):
        self.assertEqual(self.run_action("set_my_fixture_availability", "play-a", fixture_id="fa", availability="in").rowcount, 1)
        self.assertEqual(self.run_action("set_my_fixture_availability", "play-a", fixture_id="fa", availability="maybe").rowcount, 0)
        self.assertEqual(self.run_action("set_my_fixture_availability", "play-b", fixture_id="fa", availability="in").rowcount, 0)
        self.assertEqual(self.run_action("set_my_fixture_availability", "par-a", fixture_id="fa", availability="in").rowcount, 0)
        self.assertEqual(self.run_action("set_my_fixture_availability", "outsider", fixture_id="fa", availability="in").rowcount, 0)
        self.assertEqual(self.run_action("log_my_fixture_availability_change", "play-a", fixture_id="fa", old_availability="pending", new_availability="in").rowcount, 1)
        self.assertEqual(self.run_action("log_my_fixture_availability_change", "outsider", fixture_id="fa", old_availability="pending", new_availability="in").rowcount, 0)

    def test_roster_reads_are_scoped_to_team_members_and_managers(self):
        self.assertEqual(ids(self.rows("list_fixture_roster", "play-a", fixture_id="fa"), "user_id"), ["play-a"])
        self.assertEqual(self.rows("list_fixture_roster", "outsider", fixture_id="fa"), [])
        self.assertEqual(self.rows("list_fixture_roster", "mgr-b", fixture_id="fa"), [])
        self.assertEqual(self.rows("list_managed_fixture_roster", "play-a", fixture_id="fa"), [])
        self.assertEqual(self.rows("list_managed_fixture_roster", "mgr-b", fixture_id="fa"), [])
        self.assertTrue(self.rows("list_managed_fixture_roster", "conv-a", fixture_id="fa"))

    def test_fixture_reads_are_scoped_to_the_callers_club_or_team(self):
        self.assertEqual(ids(self.rows("list_my_fixtures", "play-a", **{"from": "2026-01-01"})), ["fa"])
        self.assertEqual(self.rows("list_my_fixtures", "outsider", **{"from": "2026-01-01"}), [])
        self.assertEqual(self.rows("list_my_fixtures", "mgr-b", **{"from": "2026-01-01"}), [])
        self.assertEqual(ids(self.rows("list_managed_fixtures", "conv-a")), ["fa"])
        self.assertEqual(ids(self.rows("list_managed_fixtures", "mgr-b")), ["fb"])
        self.assertEqual(self.rows("list_managed_fixtures", "play-a"), [])

    def test_club_reads_are_scoped_to_active_club_roles(self):
        for action in ("list_club_seasons", "list_club_venues", "list_club_teams", "list_club_divisions", "list_club_members"):
            with self.subTest(action=action):
                self.assertTrue(self.rows(action, "conv-a", org_id="a"))
                self.assertTrue(all(row.get("org_id", "a") == "a" for row in self.rows(action, "conv-a", org_id="a")))
                self.assertEqual(self.rows(action, "play-a", org_id="a"), [])
                self.assertEqual(self.rows(action, "mgr-b", org_id="a"), [])
                self.assertEqual(self.rows(action, "inact-a", org_id="a"), [])

    def test_club_identity_and_permission_reads_are_membership_scoped(self):
        self.assertEqual(ids(self.rows("list_managed_clubs", "conv-a")), ["a"])
        self.assertEqual(self.rows("list_managed_clubs", "play-a"), [])
        self.assertEqual(self.rows("get_club", "play-a", org_id="a")[0]["name"], "Club A")
        self.assertEqual(self.rows("get_club", "outsider", org_id="a"), [])
        self.assertEqual(self.rows("get_my_club_permissions", "play-a", org_id="a")[0]["can_manage"], 0)
        self.assertEqual(self.rows("get_my_club_permissions", "mgr-b", org_id="a"), [])
        self.assertEqual(len(self.rows("can_create_first_club", "outsider")), 1)
        self.assertEqual(self.rows("can_create_first_club", "mgr-a"), [])

    def test_result_and_document_reads_are_manager_only_and_club_scoped(self):
        self.assertEqual(ids(self.rows("list_managed_fixture_results", "conv-a"), "fixture_id"), ["fa"])
        self.assertEqual(ids(self.rows("list_managed_fixture_results", "mgr-b"), "fixture_id"), ["fb"])
        self.assertEqual(self.rows("list_managed_fixture_results", "play-a"), [])
        self.assertEqual(self.rows("list_fixture_result_history", "mgr-b", fixture_id="fa"), [])
        self.assertEqual(self.rows("list_fixture_result_history", "play-a", fixture_id="fa"), [])
        self.assertTrue(self.rows("list_fixture_result_history", "conv-a", fixture_id="fa"))
        self.assertEqual(self.rows("list_authorised_documents", "mgr-b", org_id="a"), [])
        self.assertEqual(self.rows("list_authorised_documents", "play-a", org_id="a"), [])

    def test_document_metadata_withholds_storage_keys_and_submitter(self):
        documents = self.rows("list_authorised_documents", "conv-a", org_id="a")
        self.assertEqual(ids(documents, "document_id"), ["sub-a"])
        self.assertEqual(documents[0]["has_document"], 1)
        for private in ("scorecard_path", "scorecard_user_id", "submitted_by"):
            self.assertNotIn(private, documents[0])

    def test_contact_fields_are_visible_only_to_club_managers(self):
        self.assertEqual(self.rows("list_club_venues", "conv-a", org_id="a")[0]["convenor_phone"], "0400000001")
        self.assertEqual(self.rows("list_club_venues", "play-a", org_id="a"), [])
        fixture = self.rows("list_my_fixtures", "play-a", **{"from": "2026-01-01"})[0]
        self.assertNotIn("convenor_phone", fixture)

    def test_import_reports_and_audit_trail_are_club_scoped(self):
        self.assertEqual(ids(self.rows("list_import_reports", "conv-a", org_id="a")), ["imp-a"])
        self.assertEqual(self.rows("list_import_reports", "mgr-b", org_id="a"), [])
        self.assertEqual(self.rows("list_import_reports", "play-a", org_id="a"), [])
        self.assertEqual(ids(self.rows("list_audit_events", "conv-a", org_id="a")), ["aud-a"])
        self.assertEqual(self.rows("list_audit_events", "mgr-b", org_id="a"), [])
        self.assertEqual(self.rows("list_audit_events", "play-a", org_id="a"), [])

    def test_audit_actor_is_the_authenticated_caller_and_outcome_is_checked(self):
        self.run_action("record_audit_event", "conv-a", id="aud-2", org_id="a", action="update_venue", target_type="venue", target_id="va", outcome="refused")
        actor = self.db.execute("SELECT actor_user_id,outcome FROM audit_events WHERE id='aud-2'").fetchone()
        self.assertEqual(tuple(actor), ("conv-a", "refused"))
        self.assertEqual(self.run_action("record_audit_event", "conv-a", id="aud-3", org_id="a", action="drop_everything", target_type="venue", target_id="va", outcome="succeeded").rowcount, 0)
        with self.assertRaises(sqlite3.IntegrityError):
            self.run_action("record_audit_event", "conv-a", id="aud-4", org_id="a", action="update_venue", target_type="venue", target_id="va", outcome="maybe")

    def test_invitations_activate_only_the_intended_club_and_team_membership(self):
        self.assertEqual(self.run_action("activate_invited_club_membership", "inact-a", id="cm-x", claim_token="tok-pending", display_name="Inactive").rowcount, 0)
        self.assertEqual(self.db.execute("SELECT is_active FROM club_memberships WHERE user_id='inact-a'").fetchone()[0], 0)
        self.assertEqual(self.run_action("accept_team_invite", "newbie", claim_token="wrong", display_name="Newbie").rowcount, 0)
        self.assertEqual(self.run_action("activate_invited_club_membership", "newbie", id="cm-new", claim_token="tok-pending", display_name="Newbie").rowcount, 1)
        self.assertEqual(self.run_action("activate_invited_club_membership", "newbie", id="cm-dup", claim_token="tok-pending", display_name="Newbie").rowcount, 0)
        self.assertEqual(self.run_action("accept_team_invite", "newbie", claim_token="tok-pending", display_name="Newbie").rowcount, 1)
        self.assertEqual(self.run_action("accept_team_invite", "other", claim_token="tok-pending", display_name="Other").rowcount, 0)
        row = self.db.execute("SELECT org_id,role,is_active FROM club_memberships WHERE user_id='newbie'").fetchone()
        self.assertEqual(tuple(row), ("a", "player", 1))

    def test_club_creation_and_bootstrap_are_limited_to_the_creator(self):
        self.assertEqual(self.run_action("create_club", "mgr-a", id="c-x", name="X", slug="x").rowcount, 0)
        self.assertEqual(self.run_action("create_club", "fresh", id="c-new", name="New", slug="new").rowcount, 1)
        self.assertEqual(self.run_action("bootstrap_club_admin", "outsider", id="cm-z", org_id="a", display_name="Z").rowcount, 0)
        self.assertEqual(self.run_action("bootstrap_club_admin", "founder-b", id="cm-y", org_id="a", display_name="Y").rowcount, 0)

    def test_pagination_returns_disjoint_stable_pages(self):
        for index in range(1, 6):
            self.db.execute("INSERT INTO club_memberships(id,org_id,user_id,role,display_name,is_active,created_at) VALUES (?,?,?,?,?,1,1)", (f"x{index}", "a", f"extra-{index}", "player", f"Extra {index}"))
        def users(offset):
            return [row["user_id"] for row in self.rows("list_club_members", "conv-a", org_id="a", limit=2, offset=offset)]

        pages = [users(offset) for offset in (0, 2, 4, 6, 8, 10)]
        flat = [user for page in pages for user in page]
        self.assertEqual(len(flat), 10)
        self.assertEqual(len(set(flat)), 10)
        self.assertEqual(pages[-1], [])
        self.assertEqual([users(0), users(2)], pages[:2])
        self.assertEqual(pages[0] + pages[1] + pages[2] + pages[3] + pages[4], sorted(flat, key=flat.index))

    def test_filters_narrow_managed_reads(self):
        self.assertEqual(ids(self.rows("list_managed_fixtures", "conv-a", status="scheduled")), ["fa"])
        self.assertEqual(self.rows("list_managed_fixtures", "conv-a", status="washout"), [])
        self.assertEqual(ids(self.rows("list_club_teams", "conv-a", org_id="a", division_id="da")), ["ta", "tb"])
        self.assertEqual(self.rows("list_club_teams", "conv-a", org_id="a", division_id="missing"), [])

    def test_match_day_change_refreshes_version_for_readers(self):
        before = self.rows("list_managed_fixtures", "conv-a")[0]["updated_at"]
        self.assertEqual(before, 1)
        self.run_action("update_fixture_match_day", "conv-a", fixture_id="fa", status="forfeit", match_notice="")
        self.assertEqual(self.rows("list_managed_fixtures", "conv-a")[0]["updated_at"], 1000)

    def test_every_action_has_a_permission_case(self):
        covered = set(MANAGER_WRITES) | set(MANAGER_WRITE_DENIALS_ONLY) | {
            "set_my_fixture_availability", "log_my_fixture_availability_change", "accept_team_invite",
            "activate_invited_club_membership", "create_club", "bootstrap_club_admin", "can_create_first_club",
            "get_my_club_permissions", "get_club", "list_my_fixtures", "list_fixture_roster",
            "list_fixture_import_options", "list_managed_clubs", "list_club_seasons", "list_club_venues",
            "list_club_teams", "list_club_divisions", "list_club_members", "list_managed_fixtures",
            "list_managed_fixture_roster", "list_fixture_team_candidates", "list_fixture_roster_activity",
            "list_managed_fixture_results", "list_fixture_result_history", "list_import_reports",
            "list_audit_events", "list_authorised_documents",
        }
        self.assertEqual(sorted(set(TOOLS) - covered), [])


if __name__ == "__main__":
    unittest.main()

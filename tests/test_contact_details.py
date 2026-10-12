import json
import re
import sqlite3
import unittest
from pathlib import Path

from mcp_harness import connect

ROOT = Path(__file__).resolve().parents[1]
MIGRATIONS = json.loads((ROOT / "migrations.json").read_text())["migrations"]
TOOLS = {tool["name"]: tool for tool in json.loads((ROOT / "mcp.json").read_text())["tools"]}

# Fake contact values only: no real person, club or number appears in this repository.
FAKE_PHONE = "0400000000"
FAKE_EMAIL = "convenor@example.invalid"
FAKE_ROSTER_CONTACT = "0499000000"

SEED = """
INSERT INTO organizations(id,name,slug,created_at,created_by) VALUES ('a','Club A','club-a',1,'founder-a'),('b','Club B','club-b',1,'founder-b');
INSERT INTO club_memberships(id,org_id,user_id,role,display_name,is_active,created_at) VALUES
  ('m1','a','mgr-a','manager','Manager A',1,1),
  ('m2','a','conv-a','convenor','Convenor A',1,1),
  ('m3','a','play-a','player','Player A',1,1),
  ('m4','a','par-a','parent','Parent A',1,1),
  ('m5','b','mgr-b','manager','Manager B',1,1);
INSERT INTO seasons(id,org_id,name,starts_on,ends_on,status,created_at) VALUES ('sa','a','2026','2026-01-01','2026-12-31','upcoming',1);
INSERT INTO divisions(id,season_id,name,format,created_at) VALUES ('da','sa','Div A',NULL,1);
INSERT INTO teams(id,org_id,division_id,name,colour,created_at,is_external) VALUES ('ta','a','da','Northside',NULL,1,0),('tb','a','da','Lakeside',NULL,1,0),('tc','b',NULL,'Other',NULL,1,0);
INSERT INTO team_memberships(id,org_id,team_id,user_id,display_name,invite_token,created_by,accepted_at,created_at) VALUES ('tm1','a','ta','play-a','Player A',NULL,'mgr-a',1,1);
INSERT INTO venues(id,org_id,name,address,map_url,notes,convenor_phone,created_at) VALUES
  ('va','a','Central Courts','1 Court Rd',NULL,'Enter by the north gate',%(phone)r,1),
  ('vb','a','Side Courts',NULL,NULL,'Call 0400000001 before arrival',NULL,1),
  ('vc','a','Email Courts',NULL,NULL,'Questions to convenor@example.invalid',NULL,1),
  ('vb2','b','Other Courts',NULL,NULL,'Plain notes',NULL,1);
INSERT INTO fixtures(id,org_id,division_id,home_team_id,away_team_id,venue_id,starts_at,round_label,status,created_at,time_status,match_notice) VALUES
  ('fa','a','da','ta','tb','va','2026-10-11T09:00:00+11:00','R1','scheduled',1,'confirmed','Bring a racquet'),
  ('fb','a','da','ta','tb','vb','2026-10-18T09:00:00+11:00','R2','scheduled',1,'confirmed','Call 0400000002 to confirm');
INSERT INTO fixture_roster(fixture_id,user_id,display_name,availability,confirmed_at) VALUES ('fa','play-a','Player A','pending',1);
INSERT INTO roster_players(id,fixture_id,player_name,contact,availability,created_at) VALUES ('rp1','fa','Sam Smith',%(roster)r,'pending',1);
""" % {"phone": FAKE_PHONE, "roster": FAKE_ROSTER_CONTACT}

MEMBER_ROLES = ["play-a", "par-a", "mgr-b", "outsider"]


class ContactDetailTests(unittest.TestCase):
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

    def save(self, user="conv-a", **overrides):
        values = {"id": "cd-1", "org_id": "a", "subject_type": "venue", "subject_id": "va", "label": "Convenor",
                  "kind": "phone", "value": FAKE_PHONE, **overrides}
        return self.run_action("set_contact_detail", user, **values)

    def test_legacy_venue_phone_and_roster_contact_are_migrated_into_contact_details(self):
        db = connect()
        db.row_factory = sqlite3.Row
        for migration in MIGRATIONS[:-1]:
            db.executescript(migration["sql"])
        db.executescript(SEED)
        db.executescript(MIGRATIONS[-1]["sql"])
        migrated = {(r["subject_type"], r["subject_id"], r["kind"], r["value"]) for r in db.execute(
            "SELECT subject_type,subject_id,kind,value FROM contact_details").fetchall()}
        self.assertEqual(migrated, {("venue", "va", "phone", FAKE_PHONE), ("person", "rp1", "other", FAKE_ROSTER_CONTACT)})
        db.close()

    def test_contact_values_are_readable_only_by_club_managers_convenors_and_admins(self):
        self.assertEqual(self.save().rowcount, 1)
        for user in ("mgr-a", "conv-a"):
            with self.subTest(user=user):
                values = [row["value"] for row in self.rows("list_contact_details", user, org_id="a")]
                self.assertIn(FAKE_PHONE, values)
        for user in MEMBER_ROLES:
            with self.subTest(user=user):
                self.assertEqual(self.rows("list_contact_details", user, org_id="a"), [])
                self.assertEqual(self.rows("list_contact_details", user, org_id="a", subject_type="venue", subject_id="va"), [])

    def test_unauthorised_writes_and_deletes_change_nothing(self):
        self.save()
        for user in MEMBER_ROLES:
            with self.subTest(user=user):
                self.assertEqual(self.save(user=user, id=f"cd-{user}", value="0400 000 999").rowcount, 0)
                self.assertEqual(self.run_action("delete_contact_detail", user, id="cd-1", org_id="a").rowcount, 0)
        self.assertEqual(self.db.execute("SELECT value FROM contact_details WHERE id='cd-1'").fetchone()[0], FAKE_PHONE)

    def test_structured_contacts_are_validated_and_scoped_to_their_club(self):
        self.assertEqual(self.save(id="cd-x", subject_type="venue", subject_id="vb2").rowcount, 0)
        self.assertEqual(self.save(id="cd-y", subject_type="team", subject_id="tc").rowcount, 0)
        self.assertEqual(self.save(id="cd-z", subject_type="person", subject_id="someone-unknown").rowcount, 0)
        self.assertEqual(self.save(id="cd-blank", value="   ").rowcount, 0)
        self.assertEqual(self.save(id="cd-club", subject_type="club", subject_id="b").rowcount, 0)
        self.assertEqual(self.save(id="cd-person", subject_type="person", subject_id="play-a").rowcount, 1)
        self.assertEqual(self.save(id="cd-team", subject_type="team", subject_id="ta", label="Team email", kind="email", value=FAKE_EMAIL).rowcount, 1)
        self.assertEqual(self.save(id="cd-kind", label="Fax", kind="fax").rowcount, 0)

    def test_saving_the_same_detail_updates_it_and_deleting_removes_it(self):
        self.save(value=FAKE_PHONE)
        self.assertEqual(self.save(id="cd-again", value="0400000003").rowcount, 1)
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM contact_details WHERE subject_id='va' AND label='Convenor'").fetchone()[0], 1)
        self.assertEqual(self.run_action("delete_contact_detail", "mgr-a", id="cd-1", org_id="a").rowcount, 1)
        self.assertEqual(self.run_action("delete_contact_detail", "mgr-a", id="cd-1", org_id="a").rowcount, 0)

    def test_member_facing_reads_never_include_stored_contact_values(self):
        self.save()
        self.save(id="cd-email", subject_type="team", subject_id="ta", label="Team email", kind="email", value=FAKE_EMAIL)
        self.save(id="cd-roster", subject_type="person", subject_id="rp1", label="Sam Smith", kind="other", value=FAKE_ROSTER_CONTACT)
        member_results = {
            "list_my_fixtures": self.rows("list_my_fixtures", "play-a", **{"from": "2026-01-01"}),
            "list_fixture_roster": self.rows("list_fixture_roster", "play-a", fixture_id="fa"),
            "list_team_pool": self.rows("list_team_pool", "play-a", org_id="a", team_id="ta"),
            "get_club": self.rows("get_club", "play-a", org_id="a"),
        }
        serialised = json.dumps(member_results, default=str)
        for value in (FAKE_PHONE, FAKE_EMAIL, FAKE_ROSTER_CONTACT):
            self.assertNotIn(value, serialised)

    def test_free_form_notes_that_look_like_contacts_are_withheld_from_players(self):
        rounds = {row["round_label"]: row for row in self.rows("list_my_fixtures", "play-a", **{"from": "2026-01-01"})}
        self.assertEqual(rounds["R1"]["venue_notes"], "Enter by the north gate")
        self.assertEqual(rounds["R1"]["match_notice"], "Bring a racquet")
        self.assertIsNone(rounds["R2"]["venue_notes"])
        self.assertIsNone(rounds["R2"]["match_notice"])
        serialised = json.dumps(list(rounds.values()))
        for value in ("0400000001", "0400000002"):
            self.assertNotIn(value, serialised)

    def test_note_review_flags_contact_like_notes_for_managers_without_returning_the_text(self):
        flagged = self.rows("list_contact_note_review", "mgr-a", org_id="a")
        self.assertEqual(sorted((row["subject_type"], row["subject_id"], row["field"]) for row in flagged),
                         [("fixture", "fb", "match_notice"), ("venue", "vb", "notes"), ("venue", "vc", "notes")])
        self.assertNotIn("0400000001", json.dumps(flagged))
        self.assertEqual(self.rows("list_contact_note_review", "play-a", org_id="a"), [])
        self.assertEqual(self.rows("list_contact_note_review", "mgr-b", org_id="a"), [])

    def test_roster_imports_do_not_store_a_contact(self):
        self.run_action("upsert_imported_roster_player", "conv-a", id="rp2", org_id="a", starts_at="2026-10-11T09:00:00+11:00",
                        round_label="R1", team="Northside", opponent="Lakeside", player_name="Alex Lee", contact="0400000004")
        stored = [dict(row) for row in self.db.execute("SELECT * FROM roster_players WHERE player_name='Alex Lee'").fetchall()]
        self.assertTrue(stored)
        self.assertNotIn("0400000004", json.dumps(stored, default=str))
        self.assertNotIn("contact", TOOLS["upsert_imported_roster_player"]["params"])

    def test_generated_contract_outputs_contain_no_contact_values(self):
        generated = [(ROOT / "docs" / "mcp-contract.md").read_text(), (ROOT / "web" / "src" / "generated" / "mcpCatalog.ts").read_text()]
        for text in generated:
            self.assertIsNone(re.search(r"\b\d{10}\b", text))
            self.assertIsNone(re.search(r"[\w.+-]+@[\w-]+\.[\w.]+", text))

    def test_contact_actions_are_audited_by_target_only(self):
        self.save()
        self.assertTrue(TOOLS["set_contact_detail"]["contract"]["audit"])
        self.assertTrue(TOOLS["delete_contact_detail"]["contract"]["audit"])
        self.assertNotIn("value", TOOLS["record_audit_event"]["params"])
        self.assertNotIn(FAKE_PHONE, json.dumps(TOOLS["set_contact_detail"]["contract"]) + json.dumps(TOOLS["delete_contact_detail"]["contract"]))


if __name__ == "__main__":
    unittest.main()

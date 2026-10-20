import json
import sqlite3
import unittest
from pathlib import Path

from mcp_harness import connect

ROOT = Path(__file__).resolve().parents[1]
MIGRATIONS = json.loads((ROOT / "migrations.json").read_text())["migrations"]
TOOLS = {tool["name"]: tool for tool in json.loads((ROOT / "mcp.json").read_text())["tools"]}


class FirstClubOnboardingTests(unittest.TestCase):
    def setUp(self):
        self.db = connect()
        self.db.execute("PRAGMA foreign_keys=ON")
        for migration in MIGRATIONS:
            self.db.executescript(migration["sql"])
        self.db.execute(
            "INSERT INTO organizations(id,name,slug,created_at,created_by) VALUES('existing','Existing Club','existing',1,'other')"
        )
        self.db.execute(
            "INSERT INTO club_memberships(id,org_id,user_id,role,display_name,is_active,created_at) VALUES('member','existing','member-user','player','Member',1,1)"
        )

    def tearDown(self):
        self.db.close()

    def test_new_signed_in_user_creates_club_and_becomes_admin(self):
        create = TOOLS["create_club"]
        bootstrap = TOOLS["bootstrap_club_admin"]
        eligible = TOOLS["can_create_first_club"]
        self.assertTrue(create["requires_auth"])
        self.assertTrue(bootstrap["requires_auth"])
        self.assertTrue(eligible["requires_auth"])
        self.assertNotIn("auth", create)
        self.assertEqual(self.db.execute(eligible["sql"], {"__user_id": "new-user"}).fetchone(), (1, None, None))

        self.db.execute(create["sql"], {
            "__user_id": "new-user", "__now": 10,
            "id": "new-club", "name": "New Club", "slug": "new-club",
        })
        self.db.execute(bootstrap["sql"], {
            "__user_id": "new-user", "__now": 10,
            "id": "new-admin", "org_id": "new-club", "display_name": "New User",
        })
        self.assertEqual(self.db.execute(
            "SELECT user_id,role,is_active FROM club_memberships WHERE org_id='new-club'"
        ).fetchone(), ("new-user", "admin", 1))
        # A lost bootstrap response can safely be retried after membership creation.
        self.db.execute(bootstrap["sql"], {
            "__user_id": "new-user", "__now": 11,
            "id": "retry-admin", "org_id": "new-club", "display_name": "New User",
        })
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM club_memberships WHERE org_id='new-club'").fetchone()[0], 1)
        self.db.execute(create["sql"], {
            "__user_id": "new-user", "__now": 11,
            "id": "second-club", "name": "Second Club", "slug": "second-club",
        })
        self.assertIsNone(self.db.execute("SELECT 1 FROM organizations WHERE id='second-club'").fetchone())

    def test_existing_member_cannot_create_another_club_or_bootstrap_admin(self):
        create = TOOLS["create_club"]
        bootstrap = TOOLS["bootstrap_club_admin"]
        eligible = TOOLS["can_create_first_club"]
        self.assertIsNone(self.db.execute(eligible["sql"], {"__user_id": "member-user"}).fetchone())
        self.db.execute(create["sql"], {
            "__user_id": "member-user", "__now": 10,
            "id": "denied-club", "name": "Denied", "slug": "denied",
        })
        self.db.execute(bootstrap["sql"], {
            "__user_id": "member-user", "__now": 10,
            "id": "forged-admin", "org_id": "existing", "display_name": "Member",
        })
        self.assertIsNone(self.db.execute("SELECT 1 FROM organizations WHERE id='denied-club'").fetchone())
        self.assertIsNone(self.db.execute("SELECT 1 FROM club_memberships WHERE id='forged-admin'").fetchone())

    def test_account_whose_prior_club_membership_is_inactive_cannot_create_a_duplicate(self):
        # The club this account set up still exists, but its membership was switched off: no active access, no setup offer.
        self.db.executescript("""
            INSERT INTO organizations(id,name,slug,created_at,created_by) VALUES('former','Former Club','former',1,'former-user');
            INSERT INTO club_memberships(id,org_id,user_id,role,display_name,is_active,created_at) VALUES('former-m','former','former-user','admin','Former',0,1);
        """)
        eligible = TOOLS["can_create_first_club"]
        self.assertIsNone(self.db.execute(eligible["sql"], {"__user_id": "former-user"}).fetchone())
        self.db.execute(TOOLS["create_club"]["sql"], {"__user_id": "former-user", "__now": 10, "id": "duplicate", "name": "Duplicate", "slug": "duplicate"})
        self.db.execute(TOOLS["bootstrap_club_admin"]["sql"], {"__user_id": "former-user", "__now": 10, "id": "re-admin", "org_id": "former", "display_name": "Former"})
        self.assertIsNone(self.db.execute("SELECT 1 FROM organizations WHERE id='duplicate'").fetchone())
        self.assertEqual(self.db.execute("SELECT is_active FROM club_memberships WHERE id='former-m'").fetchone()[0], 0)
        self.assertIsNone(self.db.execute("SELECT 1 FROM club_memberships WHERE id='re-admin'").fetchone())

    def test_creator_whose_club_has_no_membership_is_pointed_to_that_club_not_a_second_one(self):
        self.db.executescript("INSERT INTO organizations(id,name,slug,created_at,created_by) VALUES('pending','Pending Club','pending',1,'pending-user');")
        row = self.db.execute(TOOLS["can_create_first_club"]["sql"], {"__user_id": "pending-user"}).fetchone()
        self.assertEqual(tuple(row), (0, "pending", "Pending Club"))
        self.db.execute(TOOLS["create_club"]["sql"], {"__user_id": "pending-user", "__now": 10, "id": "second", "name": "Second", "slug": "second"})
        self.assertIsNone(self.db.execute("SELECT 1 FROM organizations WHERE id='second'").fetchone())

    def test_partial_create_survives_reload_and_creator_can_retry_bootstrap(self):
        create = TOOLS["create_club"]
        bootstrap = TOOLS["bootstrap_club_admin"]
        eligible = TOOLS["can_create_first_club"]
        params = {"__user_id": "creator", "__now": 10, "id": "pending", "name": "Pending Club", "slug": "pending"}
        self.db.execute(create["sql"], params)

        # Simulate process interruption after the organization persisted but before bootstrap.
        pending = self.db.execute(eligible["sql"], {"__user_id": "creator"}).fetchone()
        self.assertEqual(pending, (0, "pending", "Pending Club"))
        self.assertIsNone(self.db.execute("SELECT 1 FROM club_memberships WHERE org_id='pending'").fetchone())

        self.db.execute(bootstrap["sql"], {
            "__user_id": "creator", "__now": 11,
            "id": "pending-admin", "org_id": pending[1], "display_name": "Creator",
        })
        self.assertEqual(self.db.execute(
            "SELECT user_id,role FROM club_memberships WHERE org_id='pending'"
        ).fetchone(), ("creator", "admin"))
        self.assertIsNone(self.db.execute(eligible["sql"], {"__user_id": "creator"}).fetchone())

        # Even while pending, the original creator cannot create a duplicate club.
        self.db.execute(create["sql"], {
            "__user_id": "creator", "__now": 12,
            "id": "duplicate", "name": "Duplicate", "slug": "duplicate",
        })
        self.assertIsNone(self.db.execute("SELECT 1 FROM organizations WHERE id='duplicate'").fetchone())

    def test_only_original_creator_can_resume_and_existing_member_cannot_be_claimed(self):
        self.db.execute(TOOLS["create_club"]["sql"], {
            "__user_id": "creator", "__now": 10,
            "id": "pending", "name": "Pending Club", "slug": "pending",
        })
        attacker_setup = self.db.execute(TOOLS["can_create_first_club"]["sql"], {"__user_id": "attacker"}).fetchone()
        self.assertEqual(attacker_setup, (1, None, None))
        self.assertNotEqual(attacker_setup[1], "pending")
        self.db.execute(TOOLS["bootstrap_club_admin"]["sql"], {
            "__user_id": "attacker", "__now": 11,
            "id": "attacker-admin", "org_id": "pending", "display_name": "Attacker",
        })
        self.assertIsNone(self.db.execute("SELECT 1 FROM club_memberships WHERE id='attacker-admin'").fetchone())

        # A creator who has since joined a different club cannot bootstrap their old pending club.
        self.db.execute("INSERT INTO club_memberships VALUES('later-member','existing','creator','player','Creator',1,12)")
        self.db.execute(TOOLS["bootstrap_club_admin"]["sql"], {
            "__user_id": "creator", "__now": 13,
            "id": "blocked-admin", "org_id": "pending", "display_name": "Creator",
        })
        self.assertIsNone(self.db.execute("SELECT 1 FROM club_memberships WHERE id='blocked-admin'").fetchone())


if __name__ == "__main__":
    unittest.main()

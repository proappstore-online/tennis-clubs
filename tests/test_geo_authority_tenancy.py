import json
import sqlite3
import unittest
from pathlib import Path

from mcp_harness import connect

ROOT = Path(__file__).resolve().parents[1]
MIGRATIONS = json.loads((ROOT / "migrations.json").read_text())["migrations"]
TOOLS = {tool["name"]: tool for tool in json.loads((ROOT / "mcp.json").read_text())["tools"]}
NEW_MIGRATION = "0020_geo_authority_scoped_roles"

# Club-first data as it exists today, before the geographic and authority model.
CLUB_SEED = """
INSERT INTO organizations(id,name,slug,created_at,created_by) VALUES ('hawthorn','Hawthorn Tennis Club','hawthorn',1,'adm-h'),('other','Other Club','other',1,'adm-o');
INSERT INTO club_memberships(id,org_id,user_id,role,display_name,is_active,created_at) VALUES
  ('m1','hawthorn','adm-h','admin','Admin H',1,1),
  ('m2','hawthorn','conv-h','convenor','Convenor H',1,1),
  ('m3','hawthorn','mgr-h','manager','Manager H',1,1),
  ('m4','hawthorn','play-h','player','Player H',1,1),
  ('m5','hawthorn','old-h','admin','Former Admin H',0,1),
  ('m6','other','adm-o','admin','Admin O',1,1);
INSERT INTO seasons(id,org_id,name,starts_on,ends_on,status,created_at) VALUES ('season-h','hawthorn','Season H','2026-01-01','2026-12-31','upcoming',1);
"""

# Site-wide administration is bootstrapped by the operator, not granted by a club admin.
SITE_BOOTSTRAP = "INSERT INTO scoped_role_grants(id,user_id,scope_type,scope_id,role,granted_by,created_at) VALUES ('bootstrap-site','site-admin','site','site','site_admin','operator-bootstrap',1)"


class GeoAuthorityTenancyTests(unittest.TestCase):
    def setUp(self):
        self.db = connect()
        self.db.row_factory = sqlite3.Row
        for migration in MIGRATIONS:
            self.db.executescript(migration["sql"])
        self.db.executescript(CLUB_SEED)
        self.db.execute(SITE_BOOTSTRAP)
        self.build_geography_and_associations()

    def tearDown(self):
        self.db.close()

    def act(self, action, user, **params):
        return self.db.execute(TOOLS[action]["sql"], {"__user_id": user, "__now": 2000, **params})

    def rows(self, action, user, **params):
        return [dict(row) for row in self.act(action, user, **params).fetchall()]

    def build_geography_and_associations(self):
        geography = [
            ("au", "", "country", "Australia"),
            ("vic", "au", "jurisdiction", "Victoria"),
            ("north", "vic", "region", "North"),
            ("south", "vic", "region", "South"),
            ("loc-a", "north", "locality", "Northside"),
            ("loc-b", "south", "locality", "Southside"),
        ]
        for area, parent, level, name in geography:
            self.assertEqual(self.act("create_geo_area", "site-admin", id=area, parent_id=parent, level=level, name=name).rowcount, 1)
        for authority, area, name in [("auth-a", "loc-a", "Northside Tennis Association"), ("auth-b", "loc-b", "Southside Tennis Association")]:
            self.assertEqual(self.act("create_competition_authority", "site-admin", id=authority, geo_area_id=area, name=name).rowcount, 1)
        for grant, user, authority in [("g-aa", "assoc-a", "auth-a"), ("g-bb", "assoc-b", "auth-b")]:
            self.assertEqual(self.act("grant_scoped_role", "site-admin", id=grant, user_id=user, scope_type="authority", scope_id=authority, role="association_admin").rowcount, 1)

    def test_migration_seeds_level_labels_in_hierarchy_order(self):
        labels = [tuple(row) for row in self.db.execute("SELECT level,label FROM geo_level_labels ORDER BY position").fetchall()]
        self.assertEqual(labels, [("country", "Country"), ("jurisdiction", "State or province"), ("region", "Region"), ("locality", "District")])

    def test_backfill_mirrors_only_active_club_admins_and_leaves_club_access_untouched(self):
        db = connect()
        db.row_factory = sqlite3.Row
        for migration in MIGRATIONS:
            if migration["name"] != NEW_MIGRATION:
                db.executescript(migration["sql"])
        db.executescript(CLUB_SEED)
        before = [tuple(row) for row in db.execute("SELECT user_id,org_id,role,is_active FROM club_memberships ORDER BY id").fetchall()]
        db.executescript(next(m["sql"] for m in MIGRATIONS if m["name"] == NEW_MIGRATION))
        self.assertEqual([tuple(row) for row in db.execute("SELECT user_id,org_id,role,is_active FROM club_memberships ORDER BY id").fetchall()], before)
        grants = [tuple(row) for row in db.execute("SELECT user_id,scope_type,scope_id,role FROM scoped_role_grants WHERE granted_by='migration-0020' ORDER BY user_id").fetchall()]
        self.assertEqual(grants, [("adm-h", "club", "hawthorn", "club_admin"), ("adm-o", "club", "other", "club_admin")])
        db.close()

    def test_existing_club_admin_keeps_manager_access_after_migration(self):
        self.assertEqual(self.act("create_season", "adm-h", id="s-h2", org_id="hawthorn", name="2027", starts_on="2027-01-01", ends_on="2027-12-31", status="upcoming").rowcount, 1)
        self.assertEqual(self.act("create_season", "conv-h", id="s-h3", org_id="hawthorn", name="2028", starts_on="2028-01-01", ends_on="2028-12-31", status="upcoming").rowcount, 1)
        self.assertEqual(self.act("create_season", "play-h", id="s-h4", org_id="hawthorn", name="x", starts_on="2029-01-01", ends_on="2029-12-31", status="upcoming").rowcount, 0)
        self.assertEqual(self.act("create_season", "old-h", id="s-h5", org_id="hawthorn", name="x", starts_on="2029-01-01", ends_on="2029-12-31", status="upcoming").rowcount, 0)

    def test_only_site_admin_builds_the_geography_and_the_hierarchy_must_descend(self):
        self.assertEqual(self.act("create_geo_area", "adm-h", id="x1", parent_id="", level="country", name="New Zealand").rowcount, 0)
        self.assertEqual(self.act("create_geo_area", "assoc-a", id="x2", parent_id="", level="country", name="New Zealand").rowcount, 0)
        self.assertEqual(self.act("create_geo_area", "site-admin", id="x3", parent_id="", level="region", name="Not a root").rowcount, 0)
        self.assertEqual(self.act("create_geo_area", "site-admin", id="x4", parent_id="vic", level="country", name="Upward").rowcount, 0)
        self.assertEqual(self.act("create_geo_area", "site-admin", id="x5", parent_id="au", level="village", name="No such level").rowcount, 0)
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM geo_areas").fetchone()[0], 6)

    def test_site_admin_sets_level_labels_as_configuration(self):
        self.assertEqual(self.act("set_geo_level_label", "site-admin", level="jurisdiction", label="State").rowcount, 1)
        self.assertEqual(self.db.execute("SELECT label FROM geo_level_labels WHERE level='jurisdiction'").fetchone()[0], "State")
        self.assertEqual(self.act("set_geo_level_label", "assoc-a", level="jurisdiction", label="Province").rowcount, 0)
        self.assertEqual(self.act("set_geo_level_label", "site-admin", level="region", label="   ").rowcount, 0)

    def test_one_club_joins_two_associations_without_duplicating_the_club(self):
        self.assertEqual(self.act("link_club_to_authority", "assoc-a", id="l-a", authority_id="auth-a", org_id="hawthorn").rowcount, 1)
        self.assertEqual(self.act("link_club_to_authority", "assoc-b", id="l-b", authority_id="auth-b", org_id="hawthorn").rowcount, 1)
        self.assertEqual(self.act("link_club_to_authority", "assoc-a", id="l-a2", authority_id="auth-a", org_id="hawthorn").rowcount, 0)
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM organizations WHERE id='hawthorn'").fetchone()[0], 1)
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM authority_club_memberships WHERE org_id='hawthorn'").fetchone()[0], 2)

    def test_association_admin_manages_clubs_and_competitions_of_their_own_association(self):
        self.assertEqual(self.act("link_club_to_authority", "assoc-a", id="l-a", authority_id="auth-a", org_id="hawthorn").rowcount, 1)
        self.assertEqual(self.act("create_competition", "assoc-a", id="c-a", authority_id="auth-a", name="Winter Pennant").rowcount, 1)
        clubs = self.rows("list_authority_clubs", "assoc-a", authority_id="auth-a", limit=100, offset=0)
        self.assertEqual([(c["org_id"], c["club_name"]) for c in clubs], [("hawthorn", "Hawthorn Tennis Club")])
        competitions = self.rows("list_authority_competitions", "assoc-a", authority_id="auth-a", limit=100, offset=0)
        self.assertEqual([c["name"] for c in competitions], ["Winter Pennant"])

    def test_association_admin_cannot_read_or_edit_another_associations_private_data(self):
        self.act("link_club_to_authority", "assoc-b", id="l-b", authority_id="auth-b", org_id="hawthorn")
        self.act("create_competition", "assoc-b", id="c-b", authority_id="auth-b", name="Secret Ladder")
        self.assertEqual(self.rows("list_authority_clubs", "assoc-a", authority_id="auth-b", limit=100, offset=0), [])
        self.assertEqual(self.rows("list_authority_competitions", "assoc-a", authority_id="auth-b", limit=100, offset=0), [])
        self.assertEqual(self.act("create_competition", "assoc-a", id="c-x", authority_id="auth-b", name="Intruder").rowcount, 0)
        self.assertEqual(self.act("link_club_to_authority", "assoc-a", id="l-x", authority_id="auth-b", org_id="other").rowcount, 0)
        self.assertEqual(self.act("grant_scoped_role", "assoc-a", id="g-x", user_id="assoc-a", scope_type="authority", scope_id="auth-b", role="viewer").rowcount, 0)
        self.assertEqual(self.act("revoke_scoped_role", "assoc-a", grant_id="g-bb").rowcount, 0)
        self.assertEqual(self.db.execute("SELECT revoked_at FROM scoped_role_grants WHERE id='g-bb'").fetchone()[0], None)
        self.assertEqual([c["name"] for c in self.db.execute("SELECT name FROM competitions WHERE authority_id='auth-b'").fetchall()], ["Secret Ladder"])
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM authority_club_memberships WHERE authority_id='auth-b'").fetchone()[0], 1)

    def test_association_admin_grants_only_association_roles_within_their_own_association(self):
        self.assertEqual(self.act("grant_scoped_role", "assoc-a", id="g-v", user_id="staff-a", scope_type="authority", scope_id="auth-a", role="viewer").rowcount, 1)
        self.assertEqual(self.act("grant_scoped_role", "assoc-a", id="g-cm", user_id="staff-a", scope_type="authority", scope_id="auth-a", role="competition_manager").rowcount, 1)
        self.assertEqual(self.act("grant_scoped_role", "assoc-a", id="g-aa2", user_id="deputy-a", scope_type="authority", scope_id="auth-a", role="association_admin").rowcount, 1)
        self.assertEqual(self.act("grant_scoped_role", "assoc-a", id="g-ca", user_id="staff-a", scope_type="authority", scope_id="auth-a", role="club_admin").rowcount, 0)
        self.assertEqual(self.act("grant_scoped_role", "assoc-a", id="g-sa", user_id="staff-a", scope_type="site", scope_id="site", role="site_admin").rowcount, 0)
        self.assertEqual(self.act("grant_scoped_role", "assoc-a", id="g-geo", user_id="staff-a", scope_type="geo_area", scope_id="vic", role="geo_admin").rowcount, 0)
        self.assertEqual(self.act("grant_scoped_role", "assoc-a", id="g-missing", user_id="staff-a", scope_type="authority", scope_id="auth-none", role="viewer").rowcount, 0)
        self.assertEqual(self.act("grant_scoped_role", "assoc-a", id="g-dup", user_id="staff-a", scope_type="authority", scope_id="auth-a", role="viewer").rowcount, 0)

    def test_club_admin_gets_no_association_access_from_their_club_role(self):
        self.assertEqual(self.act("link_club_to_authority", "adm-h", id="l-h", authority_id="auth-a", org_id="hawthorn").rowcount, 0)
        self.assertEqual(self.act("create_competition", "adm-h", id="c-h", authority_id="auth-a", name="Club Ladder").rowcount, 0)
        self.assertEqual(self.rows("list_authority_clubs", "adm-h", authority_id="auth-a", limit=100, offset=0), [])
        self.assertEqual(self.act("grant_scoped_role", "adm-h", id="g-h", user_id="adm-h", scope_type="authority", scope_id="auth-a", role="viewer").rowcount, 0)

    def test_one_user_holds_different_roles_at_different_scopes(self):
        self.assertEqual(self.act("grant_scoped_role", "site-admin", id="g-multi", user_id="multi", scope_type="competition", scope_id="c-a", role="competition_manager").rowcount, 1)
        self.act("grant_scoped_role", "site-admin", id="g-multi-a", user_id="multi", scope_type="authority", scope_id="auth-a", role="association_admin")
        roles = self.rows("list_my_scoped_roles", "multi", limit=100, offset=0)
        self.assertEqual(sorted((r["scope_type"], r["scope_id"], r["role"]) for r in roles), [("authority", "auth-a", "association_admin"), ("competition", "c-a", "competition_manager")])
        self.assertEqual(self.rows("list_my_scoped_roles", "play-h", limit=100, offset=0), [])
        self.assertEqual(self.act("link_club_to_authority", "multi", id="l-m", authority_id="auth-a", org_id="hawthorn").rowcount, 1)
        self.assertEqual(self.act("link_club_to_authority", "multi", id="l-m2", authority_id="auth-b", org_id="hawthorn").rowcount, 0)

    def test_revoked_grant_stops_association_access_immediately(self):
        self.act("create_competition", "assoc-a", id="c-a", authority_id="auth-a", name="Winter Pennant")
        self.assertEqual(self.act("revoke_scoped_role", "site-admin", grant_id="g-aa").rowcount, 1)
        self.assertEqual(self.act("revoke_scoped_role", "site-admin", grant_id="g-aa").rowcount, 0)
        self.assertEqual(self.rows("list_authority_competitions", "assoc-a", authority_id="auth-a", limit=100, offset=0), [])
        self.assertEqual(self.act("create_competition", "assoc-a", id="c-a2", authority_id="auth-a", name="After").rowcount, 0)
        self.assertEqual(self.rows("list_my_scoped_roles", "assoc-a", limit=100, offset=0), [])
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM scoped_role_grants WHERE id='g-aa'").fetchone()[0], 1)

    def test_association_admin_cannot_revoke_a_site_grant(self):
        self.assertEqual(self.act("revoke_scoped_role", "assoc-a", grant_id="bootstrap-site").rowcount, 0)
        self.assertEqual(self.db.execute("SELECT revoked_at FROM scoped_role_grants WHERE id='bootstrap-site'").fetchone()[0], None)


if __name__ == "__main__":
    unittest.main()

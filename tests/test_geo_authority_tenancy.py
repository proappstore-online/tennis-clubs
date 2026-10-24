import json
import sqlite3
import unittest
from pathlib import Path

from mcp_harness import connect

# Foundation for issue #20: geography, competition authorities (associations), scoped roles and the membership edges.
# Everything here is synthetic. PR #27 contributed the model and its first tests; the edges, label reads, re-grant,
# scope validation and the site-administrator-only club link were added on top of it.
ROOT = Path(__file__).resolve().parents[1]
MIGRATIONS = json.loads((ROOT / "migrations.json").read_text())["migrations"]
TOOLS = {tool["name"]: tool for tool in json.loads((ROOT / "mcp.json").read_text())["tools"]}
NEW_MIGRATIONS = ["0025_geo_authority_scoped_roles", "0026_venue_and_competition_season_edges"]

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
INSERT INTO seasons(id,org_id,name,starts_on,ends_on,status,created_at) VALUES ('season-h','hawthorn','Season H','2026-01-01','2026-12-31','upcoming',1),('season-o','other','Season O','2026-01-01','2026-12-31','upcoming',1);
INSERT INTO divisions(id,season_id,name,format,created_at) VALUES ('div-h','season-h','Division H',NULL,1),('div-o','season-o','Division O',NULL,1);
INSERT INTO venues(id,org_id,name,address,created_at,shared) VALUES ('venue-h','hawthorn','Hawthorn Courts','1 Court St',1,0),('venue-o','other','Other Courts','2 Court St',1,1),('venue-o-private','other','Other Private','3 Court St',1,0);
INSERT INTO teams(id,org_id,division_id,name,colour,created_at) VALUES ('team-h','hawthorn','div-h','Hawthorn A',NULL,1);
"""

# Site-wide administration is bootstrapped by the operator, not granted by a club admin.
SITE_BOOTSTRAP = "INSERT INTO scoped_role_grants(id,user_id,scope_type,scope_id,role,granted_by,created_at) VALUES ('bootstrap-site','site-admin','site','site','site_admin','operator-bootstrap',1)"

CLUB_TABLES = ["organizations", "club_memberships", "seasons", "divisions", "venues", "teams"]


def migrate(db, upto_excluding=()):
    for migration in MIGRATIONS:
        if migration["name"] not in upto_excluding:
            db.executescript(migration["sql"])


class Base(unittest.TestCase):
    def setUp(self):
        self.db = connect()
        self.db.row_factory = sqlite3.Row
        # Production order: the club data already exists when the new migrations arrive.
        migrate(self.db, upto_excluding=NEW_MIGRATIONS)
        self.db.executescript(CLUB_SEED)
        for name in NEW_MIGRATIONS:
            self.db.executescript(next(m["sql"] for m in MIGRATIONS if m["name"] == name))
        self.db.execute(SITE_BOOTSTRAP)
        self.build_geography_and_associations()

    def tearDown(self):
        self.db.close()

    def act(self, action, user, **params):
        return self.db.execute(TOOLS[action]["sql"], {"__user_id": user, "__now": 2000, **params})

    def rows(self, action, user, **params):
        return [dict(row) for row in self.act(action, user, **params).fetchall()]

    def changed(self, action, user, **params):
        return self.act(action, user, **params).rowcount

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
            self.assertEqual(self.changed("create_geo_area", "site-admin", id=area, parent_id=parent, level=level, name=name), 1)
        for authority, area, name in [("auth-a", "loc-a", "Northside Tennis Association"), ("auth-b", "loc-b", "Southside Tennis Association")]:
            self.assertEqual(self.changed("create_competition_authority", "site-admin", id=authority, area_id=area, name=name), 1)
        for grant, user, authority in [("g-aa", "assoc-a", "auth-a"), ("g-bb", "assoc-b", "auth-b")]:
            self.assertEqual(self.changed("grant_scoped_role", "site-admin", id=grant, user_id=user, scope_type="authority", scope_id=authority, role="association_admin"), 1)

    def link(self, authority, club, link_id=None):
        return self.changed("link_club_to_authority", "site-admin", id=link_id or f"l-{authority}-{club}", authority_id=authority, org_id=club)


class MigrationAndRetainedAccessTests(Base):
    def test_migration_seeds_level_labels_in_hierarchy_order(self):
        labels = [tuple(row) for row in self.db.execute("SELECT level,label FROM geo_level_labels ORDER BY position").fetchall()]
        self.assertEqual(labels, [("country", "Country"), ("jurisdiction", "State or province"), ("region", "Region"), ("locality", "District")])

    def test_migration_only_adds_and_leaves_hawthorn_and_every_club_row_untouched(self):
        db = connect()
        db.row_factory = sqlite3.Row
        migrate(db, upto_excluding=NEW_MIGRATIONS)
        db.executescript(CLUB_SEED)
        before = {table: [tuple(row) for row in db.execute(f"SELECT * FROM {table} ORDER BY 1").fetchall()] for table in CLUB_TABLES}
        for name in NEW_MIGRATIONS:
            db.executescript(next(m["sql"] for m in MIGRATIONS if m["name"] == name))
        # A new nullable column is appended to divisions; every existing column keeps its value.
        for table in CLUB_TABLES:
            width = len(before[table][0]) if before[table] else 0
            after = [tuple(row)[:width] for row in db.execute(f"SELECT * FROM {table} ORDER BY 1").fetchall()]
            self.assertEqual(after, before[table], table)
        self.assertEqual(db.execute("SELECT COUNT(*) FROM divisions WHERE competition_id IS NOT NULL").fetchone()[0], 0)
        for table in ["authority_club_memberships", "competition_authorities", "competitions", "club_venues", "competition_seasons", "geo_areas"]:
            self.assertEqual(db.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0], 0, f"{table} must start empty: no club is placed anywhere automatically")
        db.close()

    def test_backfill_mirrors_only_active_club_admins(self):
        grants = [tuple(row) for row in self.db.execute("SELECT user_id,scope_type,scope_id,role FROM scoped_role_grants WHERE granted_by='migration-0025' ORDER BY user_id").fetchall()]
        self.assertEqual(grants, [("adm-h", "club", "hawthorn", "club_admin"), ("adm-o", "club", "other", "club_admin")])

    def test_existing_club_admin_keeps_manager_access_after_migration(self):
        self.assertEqual(self.changed("create_season", "adm-h", id="s-h2", org_id="hawthorn", name="2027", starts_on="2027-01-01", ends_on="2027-12-31", status="upcoming"), 1)
        self.assertEqual(self.changed("create_season", "conv-h", id="s-h3", org_id="hawthorn", name="2028", starts_on="2028-01-01", ends_on="2028-12-31", status="upcoming"), 1)
        self.assertEqual(self.changed("create_season", "play-h", id="s-h4", org_id="hawthorn", name="x", starts_on="2029-01-01", ends_on="2029-12-31", status="upcoming"), 0)
        self.assertEqual(self.changed("create_season", "old-h", id="s-h5", org_id="hawthorn", name="x", starts_on="2029-01-01", ends_on="2029-12-31", status="upcoming"), 0)

    def test_club_checks_stay_on_club_memberships_so_scoped_club_grants_neither_widen_nor_narrow_access(self):
        # A scoped club_admin grant does not give club access to someone who is not a club member...
        self.assertEqual(self.changed("grant_scoped_role", "site-admin", id="g-stranger", user_id="stranger", scope_type="club", scope_id="hawthorn", role="club_admin"), 1)
        self.assertEqual(self.changed("create_season", "stranger", id="s-x", org_id="hawthorn", name="x", starts_on="2027-01-01", ends_on="2027-12-31", status="upcoming"), 0)
        # ...and revoking the mirrored grant does not take access away from the existing club admin.
        self.assertEqual(self.changed("revoke_scoped_role", "site-admin", grant_id="legacy-club-admin-m1"), 1)
        self.assertEqual(self.changed("create_season", "adm-h", id="s-h6", org_id="hawthorn", name="2030", starts_on="2030-01-01", ends_on="2030-12-31", status="upcoming"), 1)


class GeographyTests(Base):
    def test_only_site_admin_builds_the_geography_and_the_hierarchy_must_descend(self):
        self.assertEqual(self.changed("create_geo_area", "adm-h", id="x1", parent_id="", level="country", name="New Zealand"), 0)
        self.assertEqual(self.changed("create_geo_area", "assoc-a", id="x2", parent_id="", level="country", name="New Zealand"), 0)
        self.assertEqual(self.changed("create_geo_area", "site-admin", id="x3", parent_id="", level="region", name="Not a root"), 0)
        self.assertEqual(self.changed("create_geo_area", "site-admin", id="x4", parent_id="vic", level="country", name="Upward"), 0)
        self.assertEqual(self.changed("create_geo_area", "site-admin", id="x5", parent_id="au", level="village", name="No such level"), 0)
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM geo_areas").fetchone()[0], 6)

    def test_level_labels_are_configuration_that_the_reads_return(self):
        self.assertEqual(self.changed("set_geo_level_label", "site-admin", level="jurisdiction", label="State"), 1)
        self.assertEqual(self.changed("set_geo_level_label", "site-admin", level="region", label="Province"), 1)
        self.assertEqual(self.changed("set_geo_level_label", "assoc-a", level="jurisdiction", label="Territory"), 0)
        self.assertEqual(self.changed("set_geo_level_label", "site-admin", level="region", label="   "), 0)
        levels = self.rows("list_geo_levels", "play-h")
        self.assertEqual([(row["level"], row["label"]) for row in levels], [("country", "Country"), ("jurisdiction", "State"), ("region", "Province"), ("locality", "District")])
        roots = self.rows("list_geo_areas", "play-h", parent_id="", limit=100, offset=0)
        self.assertEqual([(row["id"], row["level_label"]) for row in roots], [("au", "Country")])
        children = self.rows("list_geo_areas", "play-h", parent_id="vic", limit=100, offset=0)
        self.assertEqual([(row["id"], row["level_label"]) for row in children], [("north", "Province"), ("south", "Province")])

    def test_geography_reads_need_a_signed_in_caller(self):
        self.assertEqual(self.rows("list_geo_levels", ""), [])
        self.assertEqual(self.rows("list_geo_areas", "", parent_id="", limit=100, offset=0), [])


class AuthorityAndClubLinkTests(Base):
    def test_only_the_site_administrator_links_clubs_to_associations(self):
        self.assertEqual(self.changed("link_club_to_authority", "assoc-a", id="l-1", authority_id="auth-a", org_id="hawthorn"), 0)
        self.assertEqual(self.changed("link_club_to_authority", "assoc-b", id="l-2", authority_id="auth-b", org_id="hawthorn"), 0)
        self.assertEqual(self.changed("link_club_to_authority", "adm-h", id="l-3", authority_id="auth-a", org_id="hawthorn"), 0)
        self.assertEqual(self.changed("link_club_to_authority", "stranger", id="l-4", authority_id="auth-a", org_id="hawthorn"), 0)
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM authority_club_memberships").fetchone()[0], 0)
        self.assertEqual(self.link("auth-a", "hawthorn"), 1)

    def test_one_club_joins_two_associations_without_duplicating_the_club(self):
        self.assertEqual(self.link("auth-a", "hawthorn"), 1)
        self.assertEqual(self.link("auth-b", "hawthorn"), 1)
        self.assertEqual(self.link("auth-a", "hawthorn", link_id="l-again"), 0)
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM organizations WHERE id='hawthorn'").fetchone()[0], 1)
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM authority_club_memberships WHERE org_id='hawthorn'").fetchone()[0], 2)
        for assoc, authority in [("assoc-a", "auth-a"), ("assoc-b", "auth-b")]:
            clubs = self.rows("list_authority_clubs", assoc, authority_id=authority, limit=100, offset=0)
            self.assertEqual([(c["org_id"], c["club_name"]) for c in clubs], [("hawthorn", "Hawthorn Tennis Club")])

    def test_association_admin_manages_competitions_of_their_own_association(self):
        self.link("auth-a", "hawthorn")
        self.assertEqual(self.changed("create_competition", "assoc-a", id="c-a", authority_id="auth-a", name="Winter Pennant"), 1)
        competitions = self.rows("list_authority_competitions", "assoc-a", authority_id="auth-a", limit=100, offset=0)
        self.assertEqual([c["name"] for c in competitions], ["Winter Pennant"])

    def test_association_admin_cannot_read_or_edit_another_associations_private_data(self):
        self.link("auth-b", "hawthorn")
        self.act("create_competition", "assoc-b", id="c-b", authority_id="auth-b", name="Secret Ladder")
        self.assertEqual(self.rows("list_authority_clubs", "assoc-a", authority_id="auth-b", limit=100, offset=0), [])
        self.assertEqual(self.rows("list_authority_competitions", "assoc-a", authority_id="auth-b", limit=100, offset=0), [])
        self.assertEqual(self.changed("create_competition", "assoc-a", id="c-x", authority_id="auth-b", name="Intruder"), 0)
        self.assertEqual(self.changed("grant_scoped_role", "assoc-a", id="g-x", user_id="assoc-a", scope_type="authority", scope_id="auth-b", role="viewer"), 0)
        self.assertEqual(self.changed("revoke_scoped_role", "assoc-a", grant_id="g-bb"), 0)
        self.assertIsNone(self.db.execute("SELECT revoked_at FROM scoped_role_grants WHERE id='g-bb'").fetchone()[0])
        self.assertEqual([c["name"] for c in self.db.execute("SELECT name FROM competitions WHERE authority_id='auth-b'").fetchall()], ["Secret Ladder"])
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM authority_club_memberships WHERE authority_id='auth-b'").fetchone()[0], 1)

    def test_club_admin_gets_no_association_access_from_their_club_role(self):
        self.link("auth-a", "hawthorn")
        self.assertEqual(self.changed("create_competition", "adm-h", id="c-h", authority_id="auth-a", name="Club Ladder"), 0)
        self.assertEqual(self.rows("list_authority_clubs", "adm-h", authority_id="auth-a", limit=100, offset=0), [])
        self.assertEqual(self.changed("grant_scoped_role", "adm-h", id="g-h", user_id="adm-h", scope_type="authority", scope_id="auth-a", role="viewer"), 0)


class ScopedRoleTests(Base):
    def test_association_admin_grants_only_association_roles_within_their_own_association(self):
        grant = lambda gid, user, scope_type, scope_id, role: self.changed("grant_scoped_role", "assoc-a", id=gid, user_id=user, scope_type=scope_type, scope_id=scope_id, role=role)
        self.assertEqual(grant("g-v", "staff-a", "authority", "auth-a", "viewer"), 1)
        self.assertEqual(grant("g-cm", "staff-a", "authority", "auth-a", "competition_manager"), 1)
        self.assertEqual(grant("g-aa2", "deputy-a", "authority", "auth-a", "association_admin"), 1)
        self.assertEqual(grant("g-ca", "staff-a", "authority", "auth-a", "club_admin"), 0)
        self.assertEqual(grant("g-sa", "staff-a", "site", "site", "site_admin"), 0)
        self.assertEqual(grant("g-geo", "staff-a", "geo_area", "vic", "geo_admin"), 0)
        self.assertEqual(grant("g-missing", "staff-a", "authority", "auth-none", "viewer"), 0)
        self.assertEqual(grant("g-other", "staff-a", "authority", "auth-b", "viewer"), 0)
        self.assertEqual(grant("g-dup", "staff-a", "authority", "auth-a", "viewer"), 0)

    def test_a_grant_needs_an_existing_scope_of_the_right_kind(self):
        grant = lambda gid, scope_type, scope_id, role: self.changed("grant_scoped_role", "site-admin", id=gid, user_id="someone", scope_type=scope_type, scope_id=scope_id, role=role)
        self.assertEqual(grant("v1", "club", "no-such-club", "club_admin"), 0)
        self.assertEqual(grant("v2", "geo_area", "no-such-area", "geo_admin"), 0)
        self.assertEqual(grant("v3", "competition", "no-such-competition", "competition_manager"), 0)
        self.assertEqual(grant("v4", "team", "no-such-team", "team_manager"), 0)
        self.assertEqual(grant("v5", "site", "elsewhere", "site_admin"), 0)
        self.assertEqual(grant("v6", "club", "hawthorn", "club_admin"), 1)
        self.assertEqual(grant("v7", "geo_area", "vic", "geo_admin"), 1)
        self.assertEqual(grant("v8", "team", "team-h", "team_manager"), 1)

    def test_one_user_holds_different_roles_at_different_scopes(self):
        self.act("create_competition", "assoc-a", id="c-a", authority_id="auth-a", name="Winter Pennant")
        self.assertEqual(self.changed("grant_scoped_role", "site-admin", id="g-multi", user_id="multi", scope_type="competition", scope_id="c-a", role="competition_manager"), 1)
        self.assertEqual(self.changed("grant_scoped_role", "site-admin", id="g-multi-a", user_id="multi", scope_type="authority", scope_id="auth-a", role="association_admin"), 1)
        roles = self.rows("list_my_scoped_roles", "multi", limit=100, offset=0)
        self.assertEqual(sorted((r["scope_type"], r["scope_id"], r["role"]) for r in roles), [("authority", "auth-a", "association_admin"), ("competition", "c-a", "competition_manager")])
        self.assertEqual(self.rows("list_my_scoped_roles", "play-h", limit=100, offset=0), [])
        # The authority role works at auth-a and gives nothing at auth-b.
        self.assertEqual(self.changed("create_competition", "multi", id="c-m", authority_id="auth-a", name="By multi"), 1)
        self.assertEqual(self.changed("create_competition", "multi", id="c-m2", authority_id="auth-b", name="Wrong place"), 0)

    def test_every_role_other_than_association_admin_confers_no_authority_access_yet(self):
        # Only association_admin has powers over an authority. The other roles are recorded for later slices and deny by default.
        self.link("auth-a", "hawthorn")
        self.act("create_competition", "assoc-a", id="c-a", authority_id="auth-a", name="Winter Pennant")
        for index, role in enumerate(["viewer", "competition_manager", "team_manager", "scorer", "member", "club_admin", "geo_admin"]):
            user = f"role-{role}"
            with self.subTest(role=role):
                self.assertEqual(self.changed("grant_scoped_role", "site-admin", id=f"g-role-{index}", user_id=user, scope_type="authority", scope_id="auth-a", role=role), 1)
                self.assertEqual(self.rows("list_authority_clubs", user, authority_id="auth-a", limit=100, offset=0), [])
                self.assertEqual(self.rows("list_authority_competitions", user, authority_id="auth-a", limit=100, offset=0), [])
                self.assertEqual(self.changed("create_competition", user, id=f"c-{index}", authority_id="auth-a", name="Nope"), 0)
                self.assertEqual(self.changed("grant_scoped_role", user, id=f"g-esc-{index}", user_id=user, scope_type="authority", scope_id="auth-a", role="association_admin"), 0)
                self.assertEqual(self.changed("create_geo_area", user, id=f"geo-{index}", parent_id="", level="country", name="Nowhere"), 0)

    def test_revoked_grant_stops_access_immediately_and_records_who_revoked(self):
        self.act("create_competition", "assoc-a", id="c-a", authority_id="auth-a", name="Winter Pennant")
        self.assertEqual(self.changed("revoke_scoped_role", "site-admin", grant_id="g-aa"), 1)
        self.assertEqual(self.changed("revoke_scoped_role", "site-admin", grant_id="g-aa"), 0)
        self.assertEqual(self.rows("list_authority_competitions", "assoc-a", authority_id="auth-a", limit=100, offset=0), [])
        self.assertEqual(self.changed("create_competition", "assoc-a", id="c-a2", authority_id="auth-a", name="After"), 0)
        self.assertEqual(self.rows("list_my_scoped_roles", "assoc-a", limit=100, offset=0), [])
        row = self.db.execute("SELECT revoked_by FROM scoped_role_grants WHERE id='g-aa'").fetchone()
        self.assertEqual(row[0], "site-admin")

    def test_a_revoked_grant_can_be_granted_again(self):
        self.act("revoke_scoped_role", "site-admin", grant_id="g-aa")
        self.assertEqual(self.changed("create_competition", "assoc-a", id="c-gone", authority_id="auth-a", name="Denied while revoked"), 0)
        self.assertEqual(self.changed("grant_scoped_role", "site-admin", id="g-aa-again", user_id="assoc-a", scope_type="authority", scope_id="auth-a", role="association_admin"), 1)
        self.assertEqual(self.changed("create_competition", "assoc-a", id="c-back", authority_id="auth-a", name="Back"), 1)
        # It is the same grant row, active again, with the revoke cleared.
        rows = self.db.execute("SELECT id,revoked_at,revoked_by,granted_by FROM scoped_role_grants WHERE user_id='assoc-a'").fetchall()
        self.assertEqual([tuple(row) for row in rows], [("g-aa", None, None, "site-admin")])
        # Granting an active grant again changes nothing.
        self.assertEqual(self.changed("grant_scoped_role", "site-admin", id="g-aa-twice", user_id="assoc-a", scope_type="authority", scope_id="auth-a", role="association_admin"), 0)

    def test_an_association_admin_can_regrant_a_role_they_revoked_but_only_in_their_own_association(self):
        self.act("grant_scoped_role", "assoc-a", id="g-v", user_id="staff-a", scope_type="authority", scope_id="auth-a", role="viewer")
        self.assertEqual(self.changed("revoke_scoped_role", "assoc-a", grant_id="g-v"), 1)
        self.assertEqual(self.changed("grant_scoped_role", "assoc-a", id="g-v2", user_id="staff-a", scope_type="authority", scope_id="auth-a", role="viewer"), 1)
        self.act("grant_scoped_role", "assoc-b", id="g-vb", user_id="staff-b", scope_type="authority", scope_id="auth-b", role="viewer")
        self.act("revoke_scoped_role", "assoc-b", grant_id="g-vb")
        self.assertEqual(self.changed("grant_scoped_role", "assoc-a", id="g-vb2", user_id="staff-b", scope_type="authority", scope_id="auth-b", role="viewer"), 0)

    def test_association_admin_cannot_revoke_a_site_grant(self):
        self.assertEqual(self.changed("revoke_scoped_role", "assoc-a", grant_id="bootstrap-site"), 0)
        self.assertIsNone(self.db.execute("SELECT revoked_at FROM scoped_role_grants WHERE id='bootstrap-site'").fetchone()[0])


class MembershipEdgeTests(Base):
    def test_a_shared_venue_can_also_be_used_by_another_club_and_the_owner_stays_the_owner(self):
        self.assertEqual(self.changed("link_club_venue", "site-admin", id="cv-1", org_id="hawthorn", venue_id="venue-o"), 1)
        self.assertEqual(self.changed("link_club_venue", "site-admin", id="cv-2", org_id="hawthorn", venue_id="venue-o"), 0)
        self.assertEqual(self.changed("link_club_venue", "site-admin", id="cv-3", org_id="hawthorn", venue_id="venue-h"), 0)  # its own venue
        self.assertEqual(self.changed("link_club_venue", "site-admin", id="cv-4", org_id="hawthorn", venue_id="venue-o-private"), 0)  # not shared
        for user in ["adm-h", "assoc-a", "adm-o"]:
            self.assertEqual(self.changed("link_club_venue", user, id=f"cv-x-{user}", org_id="hawthorn", venue_id="venue-o"), 0, user)
        links = self.rows("list_club_venue_links", "adm-h", org_id="hawthorn", limit=100, offset=0)
        self.assertEqual([(v["venue_id"], v["relationship"]) for v in links], [("venue-h", "owner"), ("venue-o", "shared_use")])
        self.assertEqual(self.db.execute("SELECT org_id FROM venues WHERE id='venue-o'").fetchone()[0], "other")

    def test_venue_links_are_visible_to_that_clubs_managers_only(self):
        self.act("link_club_venue", "site-admin", id="cv-1", org_id="hawthorn", venue_id="venue-o")
        self.assertEqual(self.rows("list_club_venue_links", "play-h", org_id="hawthorn", limit=100, offset=0), [])
        self.assertEqual(self.rows("list_club_venue_links", "adm-o", org_id="hawthorn", limit=100, offset=0), [])
        self.assertEqual(self.rows("list_club_venue_links", "site-admin", org_id="hawthorn", limit=100, offset=0), [])
        self.assertEqual(len(self.rows("list_club_venue_links", "conv-h", org_id="hawthorn", limit=100, offset=0)), 2)

    def test_a_season_joins_a_competition_only_through_its_own_association_and_member_club(self):
        self.act("create_competition", "assoc-a", id="c-a", authority_id="auth-a", name="Winter Pennant")
        self.act("create_competition", "assoc-b", id="c-b", authority_id="auth-b", name="Southside League")
        attach = lambda user, cid, season, competition: self.changed("link_competition_season", user, id=cid, competition_id=competition, season_id=season)
        self.assertEqual(attach("assoc-a", "cs-1", "season-h", "c-a"), 0)  # Hawthorn is not yet a member of auth-a
        self.link("auth-a", "hawthorn")
        self.assertEqual(attach("assoc-a", "cs-1", "season-h", "c-a"), 1)
        self.assertEqual(attach("assoc-a", "cs-2", "season-h", "c-a"), 0)  # already attached
        self.assertEqual(attach("assoc-a", "cs-3", "season-o", "c-a"), 0)  # 'other' is not a member of auth-a
        self.assertEqual(attach("assoc-b", "cs-4", "season-h", "c-a"), 0)  # another association's administrator
        self.assertEqual(attach("assoc-b", "cs-5", "season-h", "c-b"), 0)  # Hawthorn is not a member of auth-b
        self.assertEqual(attach("adm-h", "cs-6", "season-h", "c-a"), 0)  # a club admin has no association powers
        self.link("auth-b", "hawthorn")
        self.assertEqual(attach("assoc-b", "cs-7", "season-h", "c-b"), 1)  # one club season can sit in two associations' competitions
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM competition_seasons WHERE season_id='season-h'").fetchone()[0], 2)

    def test_a_division_moves_into_a_competition_once_and_only_after_its_season_is_attached(self):
        self.link("auth-a", "hawthorn")
        self.act("create_competition", "assoc-a", id="c-a", authority_id="auth-a", name="Winter Pennant")
        assign = lambda user, division, competition: self.changed("assign_division_competition", user, division_id=division, competition_id=competition)
        self.assertEqual(assign("assoc-a", "div-h", "c-a"), 0)  # season not attached yet
        self.act("link_competition_season", "assoc-a", id="cs-1", competition_id="c-a", season_id="season-h")
        self.assertEqual(assign("assoc-b", "div-h", "c-a"), 0)
        self.assertEqual(assign("adm-h", "div-h", "c-a"), 0)
        self.assertEqual(assign("assoc-a", "div-o", "c-a"), 0)  # a division of an unattached season
        self.assertEqual(assign("assoc-a", "div-h", "c-a"), 1)
        self.assertEqual(assign("assoc-a", "div-h", "c-a"), 0)  # already placed: no silent move
        self.assertEqual(self.db.execute("SELECT competition_id FROM divisions WHERE id='div-h'").fetchone()[0], "c-a")
        # The team keeps its own division link, so the chain season - competition - division - team is intact.
        chain = self.db.execute("SELECT t.id FROM teams t JOIN divisions d ON d.id=t.division_id JOIN competition_seasons cs ON cs.season_id=d.season_id AND cs.competition_id=d.competition_id WHERE d.competition_id='c-a'").fetchall()
        self.assertEqual([row[0] for row in chain], ["team-h"])

    def test_competition_seasons_are_listed_to_their_own_association_only(self):
        self.link("auth-a", "hawthorn")
        self.act("create_competition", "assoc-a", id="c-a", authority_id="auth-a", name="Winter Pennant")
        self.act("link_competition_season", "assoc-a", id="cs-1", competition_id="c-a", season_id="season-h")
        self.act("assign_division_competition", "assoc-a", division_id="div-h", competition_id="c-a")
        rows = self.rows("list_competition_seasons", "assoc-a", competition_id="c-a", limit=100, offset=0)
        self.assertEqual([(r["season_id"], r["club_name"], r["division_count"]) for r in rows], [("season-h", "Hawthorn Tennis Club", 1)])
        for user in ["assoc-b", "adm-h", "play-h", "stranger"]:
            self.assertEqual(self.rows("list_competition_seasons", user, competition_id="c-a", limit=100, offset=0), [], user)


if __name__ == "__main__":
    unittest.main()

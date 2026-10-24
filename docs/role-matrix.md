# Role matrix

Club-scoped membership is the authoritative permission source for clubs, teams, fixtures, rosters, results, documents, contacts, imports and membership management. PAS provides identity only.

## Sources of authority

| Source | Used for | Notes |
| --- | --- | --- |
| PAS identity (`requires_auth`) | Establishing who the caller is | Every MCP tool requires authentication. |
| `club_memberships` (`role`, `is_active`, per club) | All club-level access | Checked in SQL on every restricted read and write, against the target `org_id`. |
| `team_players` and accepted `team_memberships` | Player visibility of a team's fixtures and roster | Team-scoped; independent of club role. |
| PAS app roles | Not used for access control | Matching a PAS app role name (for example `player`, `manager`, `owner`) does not grant any club permission. |

The app checks no PAS app role on the server. The client makes no PAS role checks either; UI gates follow the server's answer (for example, `list_fixture_import_options` returns rows only for managers).

Platform owner or support override: not implemented. If one is added it must be a separate, audited server-side check, not a PAS role name match.

## Club roles

- **admin**, **convenor** and **manager** have the same server permissions. Convenor is treated as a full manager.
- **player** has team-scoped access only.
- **parent** has no club-level permissions. A parent sees a team's fixtures and roster only through a `team_players` or accepted `team_memberships` row, exactly like a player. There is no parent-child relationship in the data model.
- **Inactive memberships** (`is_active = 0`) grant nothing.
- A user may hold different roles in different clubs (one `club_memberships` row per club), and team access is granted separately per team.

## Access matrix

| Area | Action | admin | convenor | manager | player | parent |
| --- | --- | --- | --- | --- | --- | --- |
| Club setup | Read seasons, divisions, teams, venues, members | Yes | Yes | Yes | No | No |
| Club setup | Create season, division, team, venue; update venue | Yes | Yes | Yes | No | No |
| Club setup | Share a venue with other clubs (owning club only; other clubs can schedule at it but cannot edit it or see its contacts) | Yes | Yes | Yes | No | No |
| Membership | Create team invite (`create_team_invite`) | Yes | Yes | Yes | No | No |
| Membership | Change club role or deactivate a member | No tool exists | No tool exists | No tool exists | No | No |
| Fixtures | Read own team fixtures (`list_my_fixtures`) | Via team row | Via team row | Via team row | Yes (team) | Yes (team, if rowed) |
| Fixtures | Read managed fixtures (`list_managed_fixtures`) | Yes | Yes | Yes | No | No |
| Fixtures | Set match-day status and notice | Yes | Yes | Yes | No | No |
| Rosters | Read published roster for a fixture (`list_fixture_roster`) | Via team row | Via team row | Via team row | Yes (team) | Yes (team, if rowed) |
| Rosters | Read managed roster, candidates, activity | Yes | Yes | Yes | No | No |
| Rosters | Add or remove a player | Yes | Yes | Yes | No | No |
| Rosters | Set own availability (`set_my_fixture_availability`) | Via team row | Via team row | Via team row | Yes (self only) | Yes (self, if rowed) |
| Results | Submit result and apply to fixture | Yes | Yes | Yes | No | No |
| Results | Read result history and card status | Yes | Yes | Yes | No | No |
| Documents | Scorecard upload and download | Managers, via result history | Same | Same | No | No |
| Contacts | Private venue convenor phone (`list_club_venues`) | Yes | Yes | Yes | No | No |
| Contacts | Player fixture projection | Venue notes and address only | Same | Same | Same | Same |
| Contacts | Roster contact details (imported) | Written by import; no read tool | Same | Same | No | No |
| Contacts | Read and write contact details (`list_contact_details`, `set_contact_detail`, `delete_contact_detail`) | Yes | Yes | Yes | No | No |
| Imports | Fixture and roster import options and writes | Yes | Yes | Yes | No | No |
| Imports | Import review screen: latest run counts and fixture provenance (`list_import_reports`, `list_managed_fixtures`) | Yes | Yes | Yes | No | No |
| Imports | Competition draw import and draw reports (`import_competition_draw`, `apply_draw_*`, `record_draw_import_*`, `get_draw_import_report`) | Yes | No | No | No | No |
| Documents | Read, `public` visibility (`list_documents`, `check_document_access`) | Yes | Yes | Yes | Yes | Yes |
| Documents | Read, `member` visibility: active club membership | Yes | Yes | Yes | Yes | Yes |
| Documents | Read, `team` visibility: active team player or accepted team member, or admin, convenor or manager | Yes | Yes | Yes | Team only | Team only |
| Documents | Read, `manager` visibility | Yes | Yes | Yes | No | No |
| Documents | Read, `admin` visibility | Yes | No | No | No | No |
| Documents | Register, update, change visibility, withdraw, mark stored (`register_document`, `update_document_details`, `change_document_visibility`, `withdraw_document`, `mark_document_stored`) | Yes, any visibility | Yes, not `admin` visibility | Yes, not `admin` visibility | No | No |
| Documents | Version history and access log (`list_document_history`, `list_document_access_log`) | Yes | Yes | Yes | No | No |
| Documents | Access attempt (`log_document_access`) | Recorded by the server; outcome is `allowed` only when the caller can see the document, otherwise `denied` | Same | Same | Same | Same |

Notes on the matrix:
- "Via team row" means the user must have an active `team_players` row or an accepted `team_memberships` row for one of the fixture's teams.
- Player and parent fixture reads never include the convenor phone or roster contact details.

## Invitations

- `create_team_invite` (admin, convenor, manager) creates a pending team membership with a one-time token.
- `activate_invited_club_membership` creates an active club `player` membership in the team's club for the redeeming user. An existing club membership is never changed: an admin stays admin, and an inactive member is not reactivated by an invitation.
- `accept_team_invite` then claims the team membership. It needs no PAS app role.
- The client calls them in that order, so a retry after a partial failure is safe.
- The PAS invite that carries the claim token is created without a `role`. The PAS SDK documents `member` as the default role for an invite, and that default is what redemption assigns on the platform. The app's server never reads PAS roles, so no club or team permission comes from it. The platform's behaviour is not verified by this repository's tests.

## Known gaps

- No tool changes a member's club role or deactivates a member. Role and activation changes are database-only today.
- Scorecard file access is enforced by platform storage, which this repository does not configure. Its authorization is unverified here.
- Roster contact details are stored by import but have no read path.
- Admin-only server actions are the competition draw import family and `admin`-visibility documents. Convenor and manager are identical server-side.

## Geography, competition authorities and scoped roles (issue #20)

Clubs are still the tenant for every existing action. The new model sits above them, and the club-first checks above are unchanged. The model comes from PR #27 and was completed directly on `main`.

- **Geography:** `geo_areas` form a tree of `country → jurisdiction → region → locality`. The display label for each level is data in `geo_level_labels`, set by a site administrator with `set_geo_level_label` and read by any signed-in user with `list_geo_levels` and `list_geo_areas`. Nothing in the app hard-codes "state", "region" or "district". A root area must be a country, and a child must sit under a higher level. Only area names are stored (see `privacy-data-classification.md`).
- **Competition authorities:** `competition_authorities` (associations) belong to a geographic area and are not clubs.
- **Membership edges, kept separate:**
  - association ↔ club: `authority_club_memberships`, one row per (authority, club). A club can join several associations without a duplicate club row.
  - club ↔ venue: a venue is owned by one club (`venues.org_id`). `club_venues` records the other clubs that also use a shared venue. `list_club_venue_links` returns both, with the relationship.
  - season ↔ competition: `competition_seasons`. A competition belongs to one authority (`competitions.authority_id`). A season can sit in several competitions.
  - competition ↔ division: `divisions.competition_id`, empty until an association administrator places the division. Division ↔ team is the existing `teams.division_id`.
- **Scoped roles:** `scoped_role_grants` holds (user, scope type, scope id, role) with `revoked_at` and `revoked_by` instead of deletion. A user can hold different roles at different scopes. The roles are `site_admin`, `geo_admin`, `association_admin`, `club_admin`, `competition_manager`, `team_manager`, `scorer`, `member` and `viewer`. A grant needs a scope that exists. A revoked grant can be granted again, which reactivates the same row.
- **What each role can do today:** `site_admin` builds the geography, creates authorities, links clubs to authorities, links a club to a shared venue, and grants or revokes any role. `association_admin` manages their own authority: competitions, season and division placement, listing its clubs, and granting `association_admin`, `competition_manager` or `viewer` there. Every other role is recorded for later slices (#22 to #24) and confers nothing yet. They deny by default, and tests assert this. There is no separate venue-administrator role; the issue does not define one.
- **Who may link a club to an association:** only a site administrator (owner decision, 2026-10-24). There is no acceptance step and no club consent. Association administrators cannot attach clubs, and neither can club administrators.
- **Isolation:** association data and writes check an active `association_admin` grant on that authority. Club administrators get nothing at association scope from their club role. An association administrator can place a club's season in their competition only if the site administrator has already linked that club to their association.
- **Backfill:** each active club `admin` gets a mirror `club_admin` grant at club scope, recorded with `granted_by = migration-0025`. Convenors, managers and former admins are not mirrored. No club is placed in an authority, and no season, division or venue is linked, automatically. The first site administrator is an operator-inserted row, never granted by the migration.

Known limits:
- Existing club actions still read `club_memberships` only, on purpose. A scoped `club_admin` grant neither widens nor narrows club access, so existing admins keep exactly the access they had. Moving club checks onto scoped grants would widen access and needs its own decision.
- The audit recorder (`record_audit_event`) accepts the new write actions on its allowlist, but it is gated to club managers, so a site or association administrator who is not also a club manager cannot record through it. Provenance is kept on the rows themselves (`created_by`, `granted_by`, `revoked_by`, `revoked_at`).
- Club-venue links and venue sharing are recorded by a site administrator only. Who else may do this is not decided.

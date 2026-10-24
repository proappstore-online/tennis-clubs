# MCP caller scope

Issue #8. Every action in `mcp.json` is scoped to the authenticated caller. This page states the rule, the scope classes an action can use, and the actions that rely on a scope other than a club role. `tests/test_mcp_caller_scope.py` checks each statement here against the manifest, and `docs/mcp-contract.md` lists every action's roles.

## The rule

1. **Every action binds the caller.** Its SQL refers to `:__user_id`, which the platform sets to the authenticated user. No action runs without a caller. An action that does not bind the caller is `caller_unscoped`; none exist, and the caller-scope test fails if one appears without a reason in `UNSCOPED`.
2. **An action that takes `org_id` binds the club as well.** Its SQL refers to `:org_id` and to the caller's membership in that club. A caller from another club gets no rows, and a write changes no rows.
3. **Club-level actions declare their roles.** The `roles` in the manifest are the club roles the SQL gate accepts (`cm.role IN (...)`). The renderer takes them from the SQL, so an action cannot declare more than its gate grants. `convenor` is always listed with `manager`.
4. **An action with no club-role gate is justified by one of the scope classes below.** Adding such an action without an entry in `JUSTIFIED` fails the caller-scope test.

## Scope classes

| Class | What the caller must be | Used by |
| --- | --- | --- |
| `team` | A member of one of the fixture's teams, through `team_players` or an accepted `team_memberships` row, in the same club. | `list_my_fixtures`, `list_fixture_roster` |
| `self` | Writes only the caller's own row. | `set_my_fixture_availability`, `log_my_fixture_availability_change`, `can_create_first_club` |
| `creator` | The user who created the club, with no other membership. | `create_club`, `bootstrap_club_admin` |
| `invite-token` | Holds a single-use invitation token. The token, not the club, is the authority, and the write binds the caller as the member. | `accept_team_invite`, `activate_invited_club_membership` |
| `member` | An active member of the club, of any role. | `get_club`, `list_external_clubs`, `list_my_clubs` |
| `site-admin` | An active site administrator (a `site_admin` grant at the site scope, not revoked). | `create_geo_area`, `set_geo_level_label`, `create_competition_authority`, `link_club_to_authority`, `link_club_venue` |
| `authority-admin` | An active `association_admin` of the one competition authority the action names, not revoked. | `create_competition`, `list_authority_clubs`, `list_authority_competitions`, `link_competition_season`, `assign_division_competition`, `list_competition_seasons` |
| `scoped-grant` | A site administrator, or an active association administrator acting inside their own authority. | `grant_scoped_role`, `revoke_scoped_role` |
| `signed-in` | Any signed-in user. Used only for data that holds no club or person data (the geography and its labels). | `list_geo_levels`, `list_geo_areas` |

Club-level actions are not listed here: their scope is the club role in `mcp.json`.

## Actions without a club-role gate

- **`list_my_fixtures`** (`team`): the caller's own fixtures, from the teams they belong to.
- **`list_fixture_roster`** (`team`): a fixture's roster, for a member of one of its two teams. The fixture must sit within one club.
- **`set_my_fixture_availability`** (`self`): a player or parent sets their own availability for a fixture they are rostered on. Other users' rows are not changed.
- **`log_my_fixture_availability_change`** (`self`): records that change for the caller only.
- **`can_create_first_club`** (`self`): reports whether the caller may create a club, and any club they created that still awaits its administrator.
- **`create_club`** (`creator`): a user with no membership and no club created by them can create one. The creator is the caller.
- **`bootstrap_club_admin`** (`creator`): the creator of a club claims its first administrator role, only while the caller holds no other membership.
- **`accept_team_invite`** (`invite-token`): a single-use invitation token binds the caller as the invited member. The caller is not yet a member of any club, so the token is what authorises the write. A second claim changes no rows.
- **`activate_invited_club_membership`** (`invite-token`): the same token creates the caller's membership in the invited club.
- **`get_club`** (`member`): a club's name and slug, for an active member of that club.
- **`list_external_clubs`** (`member`): a club's opponent clubs, read-only, for an active member of that club.
- **`list_my_clubs`** (`member`): the caller's own active memberships.
- **`create_geo_area`, `set_geo_level_label`, `create_competition_authority`, `link_club_venue`** (`site-admin`): only an active site administrator.
- **`link_club_to_authority`** (`site-admin`): only an active site administrator links a club to an association. Association and club administrators cannot, and there is no consent step.
- **`grant_scoped_role`, `revoke_scoped_role`** (`scoped-grant`): a site administrator for any scope; an association administrator only for association roles inside their own authority.
- **`list_my_scoped_roles`** (`self`): the caller's own active grants.
- **`create_competition`, `list_authority_clubs`, `list_authority_competitions`, `link_competition_season`, `assign_division_competition`, `list_competition_seasons`** (`authority-admin`): only the active administrator of that association. Another association's administrator, a club administrator and every other scoped role get no rows and change nothing.
- **`list_geo_levels`, `list_geo_areas`** (`signed-in`): the geography and its configured labels, for any signed-in user.

## Cross-club access

`tests/test_mcp_caller_scope.py` runs every read action that takes `org_id` against club `a`, as a manager of club `b` and as a user with no membership. Every such read returns no rows. Team members see their own squad row only (`list_team_pool`), and their team's roster (`list_fixture_roster`), which is the intended scope.

## Limits

- The platform enforces that the caller is authenticated. The `:__user_id` binding is only as strong as that authentication.
- The invitation token is a bearer secret. Anyone holding an unclaimed token can claim it, which is why it is single-use and expires after seven days.
- Scope is checked in SQL, so a bug in an action's SQL is a bug in its scope. The caller-scope and permission tests exercise the SQL, but a new action is only covered once it is listed in `JUSTIFIED` or gated by a club role.

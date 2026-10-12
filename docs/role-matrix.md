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

# Privacy: data classification and retention

Status: **proposed**. The classes and table map below describe the schema as of migration `0019_import_run_issues`. The retention periods are proposals for the club owner to confirm before any deletion job is built. Erasure and export workflows are not built yet (see [Open items](#open-items)).

This document covers issue #34 (slice 4 of #26). It is the reference for what may be stored, how long, and what may appear in logs.

## Classes

| Class | What it is | Examples | Visible to |
| --- | --- | --- | --- |
| **P0 Public club information** | Names and public access details that a club publishes. | Club, team, season, division and competition names; venue name, address and map link (ClubAdmin says "public access details only"); fixture times, rounds and scores. | Any signed-in member of the club. |
| **P1 Member personal data** | Who a person is in the club and what they did with a fixture. | Display names; team membership; availability (`in`/`out`/`pending`); roster selection; external opponent names entered by a manager. | Members of the same team; managers and admins of the club. |
| **P2 Contact details** | Ways to reach a person or a venue contact. | `contact_details` rows (`phone`, `email`, `postal`, `other`); convenor phone on venues. | Managers and admins only. Never shown in a player view, a roster, an import preview or a log. |
| **P3 Activity and audit records** | Who changed what, and who accessed a document. | `audit_events`, `import_runs`, `document_access_log`, `fixture_roster_activity`, `team_pool_history`, `fixture_selection_history`, import provenance and `source_row`. | Managers and admins; the platform audit. |
| **P4 Uploaded files** | Files a person uploads or a club stores. | Scorecards (`fixture_result_submissions`); library documents in `documents`. | Per the document's `visibility` and the uploader's role. |

Rule of thumb: if a value identifies a person, or links a person to a club, a fixture or a contact, it is P1 or above. Club, team and venue names are P0 unless they name a person.

## Table map

Columns marked *personal* are the ones that hold P1 to P4 values. Other columns in these tables are opaque IDs, counts or timestamps.

| Table (migration) | Class | Personal columns |
| --- | --- | --- |
| `club_memberships` (0002) | P1 | `user_id`, `display_name` |
| `club_admin_invites`, `team_memberships` (0003, 0004) | P1 | `user_id`, `display_name`, `created_by` |
| `team_players` (0002) | P1 | `user_id` |
| `roster_players` (0003) | P1 | `player_name` |
| `fixture_roster` (0002) | P1 | `user_id`, availability, selection |
| `fixture_roster_activity` (0004) | P3 | `user_id`, `display_name`, `actor_user_id` |
| `fixture_result_submissions` (0007) | P3 / P4 | `scorecard_user_id`, scorecard file reference |
| `import_runs` (0008) | P3 | `actor_user_id` |
| `audit_events` (0008) | P3 | `actor_user_id`, target identifiers |
| `team_pool_history`, `fixture_selection_history` (0010) | P3 | `user_id`, `actor_user_id`, `updated_by` |
| `import_issue_resolutions` (0011) | P3 | `actor_user_id`, `source_row`, `source_date_raw`, `source_time_raw` |
| `import_provenance`, `draw_import_runs`, `draw_import_outcomes`, `draw_import_records` (0012, 0013) | P3 | `importer_user_id`, `payload_sha256`; records may hold names from the source file |
| `contact_details` (0014) | P2 | `value` (phone, email, postal), `created_by` |
| `venues.convenor_phone` (0005; copied into `contact_details` by 0014) | P2 | phone |
| `documents`, `document_history`, `document_access_log` (0015) | P3 / P4 | `actor_user_id`, storage key, file |
| `import_run_issues` (0019) | P3 | `source_row` |
| `organizations`, `seasons`, `divisions`, `teams`, `venues` (address, map link, notes), `fixtures`, `external_clubs` | P0 | Free-text `notes` on a venue must not hold contact details (the import blocks them; see `test_venue_notes_with_contact_details_block_the_import` in `tests/test_competition_draw.py`). |

## Retention (proposed)

| Class | Keep while | Then | Proposal |
| --- | --- | --- | --- |
| P0 | The season or club exists. | Archive with the season; remove on club deletion. | Keep names and results for the historical record. |
| P1 | The person is in a team for the season. | Remove the person's link to a team and their availability 12 months after the season ends. Keep the fixture and its P0 result. | 12 months after season end. |
| P2 | The contact is current. | Remove when the membership ends or the contact is replaced; remove on request. | On request, and when the membership ends. |
| P3 | The audit is needed for traceability. | Delete the personal identifiers in audit rows after the proposed period; keep the action and counts. | 2 years. Authorised changes stay traceable for that period (issue #34 acceptance). |
| P4 | The document is current (`expires_on`) or the season is current. | Delete the file; keep the document record and its `status`. | 12 months after the season ends, or at `expires_on` if earlier. |

Deletion must go through the server, under the same role gates as the write it reverses. No client code deletes personal data directly.

## Logging

Application logs must never carry P1 to P4 values. Log opaque record identifiers only (for example an organisation, team, venue or fixture UUID), and an action name. Identifiers that link to a person (`user_id`, actor and creator IDs, scorecard IDs) are personal and are not logged either. The record of who did what belongs in the audit tables (P3), not in logs.

- The web app writes logs through `web/src/privacy/redact.ts` (`safeLog`), which removes personal-data keys and values before anything is printed. A guard test (`web/test/SafeLogging.test.ts`) fails if any file in `web/src` or `worker/src` calls `console` directly instead of going through `safeLog`.
- Platform logs (the PAS runtime, Cloudflare) are outside this repo. The app must not send personal data to them.

## Location

- Venue addresses and map links are P0 public access details. Opening a map link sends the venue address, not the user's location.
- The user's own location is personal data and is never requested without consent. See `web/src/location/consent.ts`. Consent is recorded per user in the SDK's per-user store (`app.kv`), can be withdrawn, and gates every location request. No location is stored server-side.
- A future feature that needs the user's location must call that module, and must not store a location without a new decision recorded here.

## Open items

- The owner confirms the retention periods above.
- An erasure and export workflow per person (follow-up to #29).
- No server-side deletion job exists yet; the retention periods are not enforced until one does.

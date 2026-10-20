# Privacy: data classification, retention, logging and location

Status: **proposed retention, enforced classification**. Every column in the schema has a class in [`data-classification.json`](data-classification.json), and `tests/test_data_classification.py` fails when the schema and that file disagree. The retention periods are proposals for the club owner to confirm before any deletion job is built. No automated deletion exists yet (see [Deletion and rollback](#deletion-and-rollback)).

This document covers issues #34 and #29. It is the reference for what may be stored, how long, what may appear in logs and audit records, and where location may be used.

## Classes

| Class | What it is | Examples | Visible to |
| --- | --- | --- | --- |
| `public` | Names and public access details a club publishes. | Club, season, division, team and venue names; venue address, map link and access notes; fixture times, rounds, scores and submitted set results; opponent club names. | Any signed-in member of the club. |
| `personal` | Identifies a person, or what they did with a fixture or squad. | Display and player names; memberships; availability, selection and pool; identifiers of people (`user_id`, actor and creator IDs); free text that may name someone (fixture notes, match notices, correction notes, import messages). | Members of the same team; managers and admins of the club. |
| `contact` | A way to reach a person or a venue contact. | `contact_details` values and labels; venue convenor phone; roster contact (always `NULL`). | Managers and admins only. Never shown in a player view, a roster, an import preview or a log. |
| `activity` | Audit and history records: who changed what and when. | `audit_events.target_id` and the history tables. | Managers and admins. |
| `scorecard` | A scorecard file reference and the person who uploaded it. Files are R2 objects, outside the competition archive. | `fixture_result_submissions.scorecard_path`, `scorecard_user_id`. | Per the club's scorecard rules; the file is not in the archive. |
| `document` | A stored library document file (R2). | `documents.storage_key`. | Per the document's `visibility`. |
| `secret` | A credential. | `team_memberships.invite_token`. | Nobody after the invitation is claimed. |
| `technical` | An identifier, timestamp, count, enumerated state or hash that carries no personal information by itself. | IDs, `created_at`, `confirmed_at`, `payload_sha256`, counts. | Wherever its record is visible. |
| `junior` | **Reserved.** Data about a person under 18. None is stored. | none | No one, until a retention rule and a minimisation decision exist. |
| `location` | **Reserved.** A person's or a venue's location beyond a public address. None is stored. | none | Only with recorded consent, and not stored server-side (see [Location](#location)). |

Rule of thumb: if a value identifies a person, or links a person to a club, a fixture, a squad or a contact, it is `personal` or higher. Club, team, season, division and venue names are `public`, unless they name a person.

## Retention

| Class | Keep while | Then | Proposal |
| --- | --- | --- | --- |
| `public` | The season or club exists. | Archive with the season; remove on club deletion. | Keep names and results for the historical record. |
| `personal` | The person is on the team for the season. | Remove the person's squad and roster links 12 months after the season ends. The fixture and its public result are kept. | 12 months after season end, or sooner on request. |
| `contact` | The contact is current. | Remove when the membership ends, when the contact is replaced, or on request. | On request, and when the membership ends. |
| `activity` | The audit is needed for traceability. | Remove the identifiers of people from audit and history rows; keep the action, the target record and the counts. | 2 years, proposed. |
| `scorecard` | The season is current. | Delete the file; keep the record and its status. | 12 months after the season ends, or sooner on request. |
| `document` | The document is current (`expires_on`). | Delete the file; keep the record and its status. | At `expires_on`, and 12 months after the season, whichever is earlier. |
| `secret` | The invitation is unclaimed. | Clear on claim; expire after 7 days. | 7 days, and at claim. |
| `technical` | Its record is kept. | Goes with its record. | With the record it belongs to. |
| `junior`, `location` | Not applicable: none stored. | A retention rule must be written before any column of this class is added. | — |

Two cases the issue names:

- **A player leaves a team.** The `team_players` row is deactivated, not deleted, so history still names the person. The player's pool and squad row remain until the season retention ends. The team's pool history is kept as `activity` for two years. Their availability on fixtures already played is kept as `personal` until the season retention ends.
- **A season closes.** Public results stay. The people-linked rows (squad, roster, availability, scorecard references) follow the `personal` and `scorecard` rules above, counted from the season end.

## Table map

The map is in [`data-classification.json`](data-classification.json), one entry per column. Summary by table:

- **Personal:** `club_memberships`, `team_memberships`, `team_players`, `fixture_roster`, `roster_players`, `fixtures` (notes, match notice, reviewer), `fixture_result_submissions` (submitter, correction note, scorecard references), `organizations.created_by`, `team_pool_history`, `fixture_selection_history`, `fixture_roster_activity`, `import_runs`, `import_issue_resolutions`, `import_run_issues`, `import_provenance`, `draw_import_*`, `documents`, `document_history`, `document_access_log`, `archive_run`, `items`.
- **Contact:** `contact_details`, `venues.convenor_phone`, `roster_players.contact` (always `NULL`; see `test_the_roster_contact_column_is_only_ever_written_as_null`).
- **Secret:** `team_memberships.invite_token`.
- **Scorecard:** `fixture_result_submissions.scorecard_path`, `scorecard_user_id`.
- **Document:** `documents.storage_key`.
- **Public:** club, season, division, team, venue and opponent club names; venue address, map link and access notes; fixture results and times.

## Logging

Application logs must never carry `personal`, `contact`, `secret` or `scorecard` values. Log opaque record identifiers only (an organisation, team, venue or fixture UUID), and an action name. Identifiers that link to a person (`user_id`, actor and creator IDs) are personal and are not logged.

- The web app writes logs through `web/src/privacy/redact.ts` (`safeLog`), which removes personal-data keys and values before anything is printed. `web/test/SafeLogging.test.ts` fails if any file in `web/src` or `worker/src` calls `console` directly instead of going through `safeLog`.
- Structured telemetry (imports, score submission, refused writes, page timing) goes through the schema in `web/src/telemetry/`, which accepts counts, durations and tokens only. See `docs/telemetry.md`.
- Platform logs (the PAS runtime, Cloudflare) are outside this repo. The app must not send personal data to them.

## Audit payloads

An audit row is the action, the outcome, the actor, the club and a target. The target is a record identifier, not a description of it.

- `record_audit_event` refuses a target that contains an e-mail address, a space, or a value longer than a record identifier. Roster audit targets are `fixture-id:user-id`; they carry identifiers only.
- Person identifiers in audit rows are `personal` and are kept as identifiers for traceability (manager-only). They are never names, contacts or free text.
- A test (`tests/test_audit_payloads.py`) fails if an audit row would hold a name, a contact or free text.

## Location

- **Venue addresses and map links are `public`.** A map link is an ordinary link: the map opens only when a user clicks it, and it sends the venue address to the map service, not the user's location. No map is embedded and no map tile or script is loaded. `tests/test_privacy_surfaces.py` fails if a map embed or a third-party map script appears in the app.
- **Player and user location is not stored and not requested.** The consent gate (`web/src/location/consent.ts`) is the only code that may read the device location. It records consent per user in the SDK's per-user store (`app.kv`), can be withdrawn, and gates every request. A guard test (`web/test/LocationConsent.test.ts`) fails if any other source file mentions `geolocation`.
- **The platform analytics script** (`api.proappstore.online/v1/analytics.js`) is loaded by `web/index.html` on every page. It is provided by the platform, and the app does not send it location or personal data. It is recorded here as a platform dependency, not a consent-gated feature. `tests/test_privacy_surfaces.py` fails if any other third-party script is added.

## Junior data

No date of birth, age, guardian or junior flag is stored. The `junior` class is reserved. `tests/test_data_classification.py` fails if a column name suggests such data (`dob`, `birth`, `age`, `junior`, `minor`, `guardian`) or uses the reserved class. A future junior feature needs a retention rule, a parental-consent decision, and a change to this document before any column is added.

## Deletion and rollback

No deletion job exists, and no action deletes personal data in bulk. The steps below are the procedure until one does. Each class is removed with the server action for its record, under the same role gate as the write it reverses. Client code never deletes data directly.

| Class | Deletion step | Rollback step |
| --- | --- | --- |
| `contact` | Use `delete_contact_detail` (managers). | Re-enter the contact with `set_contact_detail`. The value is not kept elsewhere. |
| `personal` (squad) | Use `deactivate_team_player`, then clear the squad row through the platform administrator. | Reactivate with `set_team_player_pool`. Use the archive restore for records removed after an archive was taken. |
| `personal` (roster) | Use `remove_fixture_roster_player`. | Add back with `add_fixture_roster_player`, or restore from an archive taken before the removal. |
| `scorecard` | Withdraw the record with the document actions, then remove the file through the platform administrator. | Restore the record from an archive. The file cannot be restored from this repository. |
| `document` | `withdraw_document` (the record stays for history). | Restore the record from an archive, then re-register the file. |
| `activity` | Retention job not built: removal is by the platform administrator, under the rule above. | None. Audit rows are not changed by the app. |
| `public` | Removed with the club or season. | Restore from the club archive (`restore_archive_*`). |
| `secret` | Clear the invitation (issue a new one, or let it expire). | Issue a fresh invitation. |

Before any deletion, take a checkpoint export with `export_competition_archive` (see [`competition-archive-runbook.md`](competition-archive-runbook.md)). The archive restore is the only way back for removed competition records, and it only restores records that were in the archive.

## Open items

- The club owner confirms the retention periods above.
- A per-person erasure and export workflow (the rule for each class is written; the workflow is not built).
- No server-side deletion job exists. Retention periods are not enforced until one does.
- The analytics script is platform-owned. Its consent and retention are the platform's, and the app cannot change them.

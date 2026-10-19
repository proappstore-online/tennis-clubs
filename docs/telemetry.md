# Telemetry

Status: in force. Issue #36 (slice 6 of #26). The code is in `web/src/telemetry/`. Events go to the platform log sink, `app.logs`, which the app owner reads in the console. There is no telemetry table in the database.

## Rules

- **Closed schema.** Each event name has a fixed list of fields and their types (`web/src/telemetry/events.ts`). Counts are whole numbers, durations are milliseconds, outcomes are enumerated, and names are lower-case tokens. A field outside the schema is dropped. An event that fails its schema is not sent.
- **No personal data by construction.** No field can carry free text, a name, an e-mail address, a phone number, a user or club identifier, an invitation code, or a raw URL path. Issue messages, field names, remediation text and source rows are never passed to telemetry (`web/src/telemetry/domain.ts`).
- **Never breaks the app.** Emission never throws. A missing sink or a failing capture is ignored.
- **One sink.** Only `emit()` calls the log sink. A guard test fails if other code calls `app.logs` directly.
- **Anonymous.** The SDK's log sink works signed out and identifies a browser only by a per-install random ID, which is not a person identifier (see `privacy-data-classification.md`).

## Events

| Event | Level | Fields | Emitted when |
| --- | --- | --- | --- |
| `import.completed` | info | `kind` (fixtures or roster), `received`, `saved`, `rejected`, `status` (saved or rejected), `blocking`, `warnings` | A fixture or roster import is recorded (`FixtureImport`). |
| `import.anomaly` | warn | `kind`, `code` (the validation code), `severity` (blocking or warning), `count` (rows with that code and severity) | A fixture import's validation issues are stored (`FixtureImport`). One event per code and severity. |
| `score.submitted` | info | `outcome` (succeeded or refused) for the submission, `applied` (succeeded, refused, or null when the submission was refused and never applied) | A fixture result save ends (`RosterAdmin`). |
| `write.refused` | warn | `action` (the server action name), `target_type` | Any audited write is refused: the server changed no rows (`recordAudit`). This covers role checks and state checks alike. |
| `page.load` | info | `route`, `ttfb_ms`, `dcl_ms`, `load_ms` | Once per document, after the load event. Times come from the Navigation Timing entry. |
| `page.view` | info | `route`, `render_ms` | Each time a signed-in screen renders (`AuthenticatedApp`). |

Route names are fixed: `comps`, `fixtures`, `fixture_import`, `rosters`, `documents`, `import_review`, `admin`, `join`, `sign_in`, and `other` for any unknown path. Invitation links are reported as `join`, so the invite code never leaves the browser.

`write.refused` replaces the name `permission.denied` from the plan. A refused write is any write the server did not apply. That includes a role check, but also a fixture that is already approved, so the event does not claim a permission failure.

## Errors and public pages

- **Uncaught errors and rejected promises** on every page, including the sign-in screen, are captured automatically by the SDK's `app.logs` (`window.onerror` and `unhandledrejection`). The app adds no error event of its own, so there is no second copy.
- **The sign-in screen** is the only public page. Its load timing is reported as `page.load` with route `sign_in`.

## Not covered

- **Server-side events.** The worker and the `mcp.json` actions do not emit telemetry in this slice. The database already records imports, submissions and audits; those tables are the server-side record.
- **Metrics aggregation.** Events are read from the platform log console. There is no dashboard or alerting here.
- **Map and directory search timing.** No search exists yet (see `performance-budgets.md`).

## Adding an event

1. Add the event name and its fields to `SCHEMAS` and a level to `LEVEL` in `web/src/telemetry/events.ts`. Each field must be a count, a duration, an enumerated value or a token.
2. Build the event from counts and codes in `domain.ts` or `pages.ts`, and emit it with `emit()`.
3. Add a test in `web/test/Telemetry*.test.ts`. The guard in `TelemetryGuard.test.ts` fails if the event has no emitter.
4. Update the table above.

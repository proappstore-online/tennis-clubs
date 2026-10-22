# Platform quality: accessibility, privacy and operations

Issue #26. This page records what the platform quality work has delivered, how each point is checked, and the privacy, accessibility and rollback considerations for each child epic (#20 to #25). It is the place to look when an epic needs to know what the platform already guarantees.

## Status against #26

| Acceptance | Status | Evidence |
| --- | --- | --- |
| 1. Public directory and fixture pages work on a phone, keyboard and screen reader (read as signed-in pages, see "Decisions" below) | **Partly met.** Keyboard and semantics are tested in jsdom and by axe. Phone-width layout and screen-reader behaviour are not checked: jsdom does not lay out CSS, so a jsdom test at a narrow width would not test layout. | `web/test/DirectoryAccessibility.test.tsx`, `AxeDirectoryFixtures.test.tsx`, `AccessibilityBaseline.test.ts`. Browser verification is a follow-up (see below). |
| 2. Authorised data is traceable without personal data in application logs | Met for telemetry. | `docs/telemetry.md`, `web/test/SafeLogging.test.ts`, `TelemetryGuard.test.ts`, `tests/test_telemetry_schema.py`. |
| 3. Core public pages have measurable performance and error telemetry | Met. | `page.load`, `page.view` and `page.error` in `docs/telemetry.md`; budgets in `docs/performance-budgets.md`. |
| 4. Every epic has documented privacy, accessibility and rollback considerations | Met by this page, for #20 to #25. Each row below is a decision or a stated open question. | The table in "Child epics" below. |

## Decisions

- **Acceptance 1 covers signed-in pages.** CLAUDE.md says all database operations require sign-in, and there is no anonymous read access. So "public directory and fixture pages" means pages that any signed-in user can see, not pages open to anonymous visitors. `PUBLIC_ROUTES` in `web/src/seo.ts` stays `/`, the sign-in route.
- **The directory page is `Comps`** (`web/src/App.tsx`). There is no `ClubDirectory` component. The fixture page is `web/src/pages/FixtureList.tsx`.
- **Axe coverage** is in `web/test/AxeDirectoryFixtures.test.tsx`. It covers the fixture page with fixtures, empty and error states, and the directory page with fixtures and the fixture dialog open.
- **No phone-width jsdom tests.** A test at a narrow `window.innerWidth` would not change what these components render, so it would show nothing about layout. Phone layout needs a browser check (see Follow-ups).
- **Open items are not duplicated as new issues.** The open positions below belong to #20 to #25, which already track the features they depend on. They stay open until those epics build the features.

## Design system and accessibility baseline (#31, #32)

Delivered in `9f974f0`.

- Mobile-first layout: styles are written for the smallest screen first and widened with `min-width` media queries. Guarded by `AccessibilityBaseline.test.ts`.
- Colour tokens in `web/src/index.css`, with contrast checked for the text and surface pairs by `ContrastTokens.test.ts`.
- Keyboard: a skip link is the first Tab stop in the header and targets a focusable `#main-content` wrapper. Focus rings are visible on buttons, links, inputs, selects and textareas.
- Layout primitives (#40): `PageFrame`, `Stack` and `CardGrid` in `web/src/ui/layout.tsx`, backed by the `.container-app`, `.stack*`, `.grid-auto` and `.grid-3` classes. The directory (`Comps`) and the fixture page use them. The classes set no height, transition, animation or transform, and `web/test/LayoutPrimitives.test.tsx` fails if one does. That keeps the 44px control minimum and the reduced-motion rule in force for everything inside them. It is a stylesheet check, not a rendered one.
- Touch targets: native controls are at least 44px.
- Motion: transitions, animations and press-scale effects are switched off under `prefers-reduced-motion`.
- Semantics: the fixture period tabs follow the ARIA tabs pattern (arrow keys, Home and End), and the directory dialog is a named modal that moves focus in and returns it on close. Covered by `DirectoryAccessibility.test.tsx`.

Not verified: the rendered layout at phone widths, VoiceOver or TalkBack behaviour, and the reading order of the real pages. jsdom does not lay out CSS, so these need a browser check.

## Privacy and telemetry (#29, #36)

- Every column is classified in `docs/data-classification.json`, and `docs/privacy-data-classification.md` gives the retention and deletion rules. `tests/test_data_classification.py` fails if a column is unclassified.
- Audit targets refuse names, contacts and free text (`record_audit_event`).
- Telemetry uses a closed schema (`web/src/telemetry/events.ts`). It never carries free text, a name, an e-mail address, a phone number, a user or club identifier, an invitation code or a raw URL path. See `docs/telemetry.md`.
- Location is consent-aware: `web/test/LocationConsent.test.ts` covers it, and the app loads no map provider and no unlisted third party (`test_privacy_surfaces.py`).

## Operations: performance and recovery (#30, #35, #37)

- Performance budgets are in `docs/performance-budgets.json`, enforced by `scripts/check-page-budget.py` and `scripts/check-bundle-budget.py`.
- Competition records can be exported, restored and rehearsed. See `docs/competition-archive-runbook.md`. The restore is additive and never overwrites a record. The recovery rehearsal runs on every test run (`tests/test_recovery_rehearsal.py`).
- Rollback of the schema is by expand and contract only: `migrations.json` is additive, so a deploy can always be reverted in code without dropping a column.

## Child epics

Each epic gets a privacy, accessibility and rollback position. "Decided" means the position is recorded here and nothing else is needed to build it. "Open" means the epic has to make the decision before it ships.

| Epic | Privacy | Accessibility | Rollback |
| --- | --- | --- | --- |
| #20 Foundation: geography, tenancy, scoped roles | Decided: scope is checked in every action's SQL, as the role matrix already does (`docs/role-matrix.md`, `test_mcp_caller_scope.py`). A user's role at one scope never grants another. | Open: the role labels shown to users need plain-language wording and a screen-reader-friendly role switcher. | Decided: the backfill from organisation-as-club is additive (a new scope table, existing rows kept), so the old model keeps working if the change is reverted. |
| #21 Public directory and map | Decided: no public player contacts, junior rosters or private scorecards (the epic's non-goal). Location uses the consent rules already in place. | Decided: a missing or blank location is shown as unknown, never as a pin. The map has a text list alongside it, so it is not the only way to find a club. Open: how the map itself is operated by keyboard. | Open: no feature flag exists yet. Decide whether the map can be turned off without losing the list. |
| #22 Competitions, seasons, ladders, archive | Decided: the archive excludes contact details and scorecards (`competition-archive-runbook.md`). | Open: ladder tables need proper header associations and a text summary of the calculation. | Decided: finalised seasons are immutable. Amendments are new, traceable records, and restore never overwrites. |
| #23 Public fixtures and results | Decided: no junior player data or private attachments on public pages. Privacy is asserted by automated tests (`test_privacy_surfaces.py`). | Decided: filters are reflected in the URL so they can be shared. Open: the status history needs to be readable without colour. | Decided: result submissions are append-only (`fixture_result_submissions`). A published score is never overwritten; corrections are new rows. |
| #24 Club Zone | Decided: the public and private projections are separate. Roster writes are gated by role and club (`test_role_matrix.py`). Open: there is no scorer-specific test that another club's roster cannot be read; add one when the scorer role ships. | Open: guided score entry needs a keyboard and screen-reader pass once it is built. | Decided: every high-risk write is audited (`test_audit_payloads.py`), so a bad change can be traced. |
| #25 Migration from TROLS-era data | Decided: import is subject to the same contact and provenance rules. Source permission must be recorded before import. | Open: the review screens need the same keyboard rules as #24. | Open: batch rollback and replay are not built. The existing draw import is atomic (one transaction), which covers one batch; a batch-level undo needs its own design. |

## Follow-ups

- Browser verification of the public directory and fixture pages at phone width, by keyboard, and with a screen reader (#26 acceptance 1). The repo has no browser test runner; this needs a decision on one.
- The open accessibility and rollback positions above, to be settled in the epic that builds each feature.

## Test runs

Last recorded in the commit that added this page. The full suite is run serially, and a load-sensitive axe check was given a longer timeout where the machine was under heavy load.

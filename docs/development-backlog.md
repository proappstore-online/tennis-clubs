# Tennis Clubs development backlog

Comps is the first module. These issues are deliberately small, independently deployable units for the Tennis Clubs coder.

## TC 1 Import a fixture book and team roster

**Priority:** highest

Build a manager-only import flow for a season draw and team roster. Support a CSV export from the existing workbook first; do not rely on the legacy XLS format in the browser.

Acceptance criteria:

- Manager maps columns for date, round, opponent, home/away, venue and team.
- Import creates or updates fixtures without duplicating a match.
- Import reports invalid dates, missing teams and unmatched venues before saving.
- Player names and contact details are never made public by the import preview.

## TC 2 Club and team setup

**Priority:** highest

Build the manager workflow to create a club, season, division, teams and venues. Add members to a team using PAS platform invites and role-scoped membership records.

Acceptance criteria:

- An admin can create a season, division, venue and team.
- A player only sees fixtures for teams they belong to.
- A manager can view team members without exposing private contacts to other players.
- Every write has a server-side membership/role guard.

## TC 3 Roster publishing and availability

**Priority:** high

Add the manager view for publishing a fixture roster and monitoring replies.

Acceptance criteria:

- A manager adds/removes players from an individual fixture roster.
- Players can set in, out or not sure for their own roster record only.
- Managers see counts for in, out and pending players.
- Roster changes leave a timestamped activity trail.

## TC 4 Venue directory and travel details

**Priority:** high

Turn the fixture-book venue directory into reusable, role-scoped venue records.

Acceptance criteria:

- Venue includes name, address, directions/map link and access notes.
- A fixture displays the resolved venue rather than duplicated address text.
- Updating a venue updates every linked fixture.
- Public player pages never expose private convenor phone numbers by default.

## TC 5 Match-day status and notices

**Priority:** medium

Let authorised managers publish scheduled, washout, heat-out, forfeit and complete statuses, plus a concise match-day notice.

Acceptance criteria:

- Only authorised club roles can change a match status.
- A status change is visibly timestamped and shown on the player fixture card.
- Started-set scores can be retained when a match is stopped.
- The app records facts and never determines disciplinary penalties.

## TC 6 Results and scorecard follow-up

**Priority:** medium

Add result entry, scorecard attachment and deadline/correction tracking after the fixture and roster workflow is proven.

Acceptance criteria:

- A manager records team score and optional per-set results.
- A card image/PDF can be attached privately to the club.
- Late or incomplete cards are visible to the relevant manager.
- Corrections preserve the original submission history.

## TC 7 Hardening and release readiness

**Priority:** high, before broad club use

Add focused tests for authorization, imports, availability changes and responsive player views.

Acceptance criteria:

- Registered actions are tested for cross-club isolation.
- A player cannot alter another player’s availability or retrieve another team’s roster.
- Comps is usable at 375 px width with 44 px touch targets.
- Build, typecheck and PAS compliance pass in CI.

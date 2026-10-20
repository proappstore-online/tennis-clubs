# Competition archive: export, restore and recovery runbook

Issue #37. The archive is the only restore path for competition records. Cloudflare D1 point-in-time restore is not available to this app, so the procedure below is the way back to a known state. Read the privacy section before you handle an archive file.

## Overview

An archive is one JSON document for one club. It is produced by the `export_competition_archive` action and read back by `import_competition_archive` and the `restore_archive_*` actions.

The archive has `format` set to `tennis-clubs-competition-archive`, `format_version` set to `1`, the club's `organization` (id, name, slug), and these sections, restored in this order:

| Section | Restore step | What it holds |
| --- | --- | --- |
| `seasons` | `restore_archive_seasons` | Season names, dates and status. |
| `divisions` | `restore_archive_divisions` | Divisions within a season. |
| `venues` | `restore_archive_venues` | Venue name, address, map link, notes and whether it is shared. |
| `external_clubs` | `restore_archive_external_clubs` | Opponent clubs and their home venue. |
| `external_club_aliases` | `restore_archive_external_club_aliases` | Alternative names for opponent clubs. |
| `teams` | `restore_archive_teams` | Internal and external teams. |
| `team_players` | `restore_archive_team_players` | Squad members and their pool. |
| `fixtures` | `restore_archive_fixtures` | Fixtures, times, scores, status and review status. |
| `fixture_roster` | `restore_archive_fixture_roster` | Players named on each fixture roster, with availability and selection. |
| `roster_players` | `restore_archive_roster_players` | Players added to a fixture by name. |
| `fixture_result_submissions` | `restore_archive_result_submissions` | Every result submission, with its scores, sets and correction note. This is the full result history. |

**Not in the archive, by design:**

- **R2 documents.** Scorecard files and library documents are out of scope for this archive. The scorecard file reference and the uploader of a scorecard are left out of the result submissions.
- **Contact details.** Venue convenor phone numbers and the `contact_details` table are not exported.
- **Import provenance.** Source row numbers, raw dates and times, and import-run references are left out.
- **Membership and access.** Club memberships, team invitations and roles are not restored. The club and its managers must already exist in the target before a restore.
- **Other clubs.** An archive holds one club only.

Free-text fields (fixture notes, match notices, venue notes and result correction notes) are exported only when they contain no e-mail address and no run of seven or more digits, after spaces, hyphens, dots, slashes and brackets are ignored. Otherwise they are exported as empty.

## Privacy

- **Player names and user identifiers are personal data.** The archive includes roster player names and the platform user identifiers that link a name to a fixture, a squad or a submission. Restoring needs those identifiers.
- **Export and restore are manager-only.** The action checks, against the club, that the caller is an admin, convenor or manager. Players, parents and managers of other clubs get no rows.
- **Treat every archive file as sensitive.** Store it only where club managers can reach it. Do not e-mail it, paste it into a chat, or commit it to the repository. Delete a copy once the restore is verified and the file is no longer needed.
- **No contact details, scorecards or import provenance are in the file** (see above). If you find one, stop, do not restore, and report it.

## Accessibility

The archive has no screen. Export, check and restore run through the app's action interface (an MCP client or the admin tooling), not through a page. If a page is later added to run these steps, it must meet the same keyboard, label and focus rules as the rest of the club setup screens.

## Export procedure

1. Sign in as an admin, convenor or manager of the club.
2. Call `export_competition_archive` with `org_id` set to the club's id. It returns one row with `archive` (the JSON text) and `exported_at`. If it returns no row, you are not a manager of that club.
3. Save the `archive` text to a file named with the club and the export time. Keep the file private (see Privacy).
4. Count the records in each section of the saved file, and record the export with `record_archive_run`:
   - `org_id`: the club's id
   - `direction`: `export`
   - `row_counts`: a JSON object such as `{"org_id":"club-a","seasons":1,"divisions":4,...}`

`archive_run` has no club column, so put `org_id` in `row_counts`. Each record of an archive run is then traceable to its club.

## Restore procedure

Use this procedure to recover records that are missing from a club. Restore is additive: it fills in records that are not present and never changes a record that still exists.

1. **Prepare the target.** The club (`organizations` row) and the people who will run the restore must already exist, with active admin, convenor or manager memberships for that club. The archive's `organization.id` must equal the target club's id.
2. **Export a checkpoint first** from the target, if it still holds any records. This is the only way back if the restore turns out to be wrong (see Rollback).
3. **Check the archive.** Call `import_competition_archive` with `org_id` and `archive`. Confirm:
   - `valid` is `1`. A `0` means the archive belongs to another club or is not format version 1. Stop.
   - For each section, `<section>_in_archive` is the count you expect, and `<section>_to_restore` shows how many records are missing.
4. **Restore, in order.** Call the eleven `restore_archive_*` actions in the order of the table above, each with `org_id` and `archive`. Each returns `changes`, the number of records it wrote. Record each step with `record_audit_event` (`action` set to the step's name, `target_type` set to `competition_archive`, `target_id` set to the club id, `outcome` set to `succeeded` when `changes` is above zero and `refused` when it is zero).
5. **Verify.** Call `import_competition_archive` again. Every `<section>_to_restore` must now be `0`.
   - If any count is above `0`, a record's parent is missing from the archive or from the club (for example, a fixture whose team was not restored). Find the parent, restore it, and repeat step 5. Do not edit the archive file to force a restore.
6. **Record the run** with `record_archive_run`, `direction` set to `import`, and `row_counts` holding `org_id` and the `changes` of each step.

Restoring the same archive a second time writes nothing (every step returns `changes` of `0`), so an interrupted restore can be resumed by running steps 4 to 6 again.

## Rollback

- **Restoring twice is safe.** A repeated restore writes nothing new.
- **A restore cannot damage an existing record.** It never updates or deletes an existing row, so the records a club already holds keep their current values.
- **There is no automated undo.** No action in this version deletes restored records. To undo a restore, return to the checkpoint export from step 2 of the restore procedure, and ask a platform administrator to remove the records the restore added. Compare the club's records with the checkpoint to list them.
- **Check counts, not just the summary.** After any restore, export the club again and compare the section counts with the archive you restored. They should match, plus any records created after the export.

## Restore failure cases

| Symptom | Likely cause | Action |
| --- | --- | --- |
| `valid` is `0` | Archive is for another club, or is a different format version. | Use the archive exported for this club. |
| `restore_archive_*` returns `changes` of `0` on the first run | The caller is not a manager of the club, or the records already exist. | Check the membership, then run `import_competition_archive` to see what is missing. |
| `<section>_to_restore` stays above `0` | A parent record is missing (a fixture's team, a roster's fixture). | Restore the parent first, or check the archive is complete. |
| A restored name or score looks wrong | The record already existed and was kept as it was. | Compare with the checkpoint. Restore does not overwrite. |

## Testing

`tests/test_competition_archive.py` is the automated restore test. It:

- seeds a club with every record type, a second club, and fields that must stay out of the archive;
- checks that only managers can export, and that contact details, scorecards, provenance and other clubs are absent;
- restores the archive into a fresh copy of the club and checks that the re-export is identical to the original, including player names and results;
- checks that a second restore writes nothing, that existing records are never overwritten, that players and archives from another club are refused, that a record with a missing parent is reported and not restored, and that every restore step can be recorded as an audited action.

Run it with:

```
cd tests && python3 -m unittest test_competition_archive -v
```

`tests/test_mcp_contract.py` checks that the archive actions follow the platform rules for roles, idempotency and audit, and `tests/test_mcp_permissions.py` checks that each action is covered.

## Known limits

- **Migration numbering.** The archive audit table is migration `0023_competition_archive`. The migrations before it end at `0019`, so there is no `0020` to `0022`.
- **Result history.** Each submission is a row in `fixture_result_submissions`, which keeps the full history. There is no separate result-history table.
- **No automated delete.** See Rollback.
- **Users must already exist.** A restore refers to people by their platform user identifiers. Those people must still be club members for the rosters to be useful.

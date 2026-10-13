import { describe, expect, it } from 'vitest'
import { issueRecords, upsertFixtureArgs, warningCodesFor, type FixtureRow, type ValidationIssue } from '../src/pages/fixtureImportLogic'

const issues: ValidationIssue[] = [
  { source_row: 2, severity: 'warning', code: 'start_time_missing', field: 'start_time', message: 'No start time', remediation: 'Accept as TBC' },
  { source_row: 2, severity: 'warning', code: 'estimated_time', field: 'time_status', message: 'Estimated time', remediation: 'Accept or confirm' },
  { source_row: 2, severity: 'warning', code: 'estimated_time', field: 'time_status', message: 'Estimated time again', remediation: 'Accept or confirm' },
  { source_row: 2, severity: 'blocking', code: 'team_not_found', field: 'team', message: 'Team unknown', remediation: 'Correct the team' },
  { source_row: 3, severity: 'warning', code: 'duplicate_row', field: 'round', message: 'Duplicate row', remediation: 'Remove it' },
]

const row = (overrides: Partial<FixtureRow> = {}) => ({
  date: '2026-05-09', round: ' R2 ', opponent: 'Lakeside', home_away: 'home', venue: 'Central Courts', team: 'Northside', season: '2026',
  source_row: 2, source_date_raw: '09/05/2026', org_id: 'a', home_team_id: 'ta', away_team_id: 'tb', venue_id: 'va',
  timing_status: 'tbc', starts_at: '2026-05-09T00:00:00+10:00', arrival_at: null, start_time: '', ...overrides,
}) as FixtureRow

describe('import payload for each row', () => {
  it('declares each warning code once, sorted, and only for that row, never blocking issues', () => {
    expect(warningCodesFor(issues, 2)).toEqual(['estimated_time', 'start_time_missing'])
    expect(warningCodesFor(issues, 3)).toEqual(['duplicate_row'])
    expect(warningCodesFor(issues, 9)).toEqual([])
  })

  it('sends the row its own codes and no run-wide count', () => {
    const args = upsertFixtureArgs(row(), 'run-1', issues, 'f-1')
    expect(args.warning_codes).toBe('["estimated_time","start_time_missing"]')
    expect(args.import_run_id).toBe('run-1')
    expect(args.source_row).toBe(2)
    expect(args).not.toHaveProperty('warning_count')
    expect(args.round_label).toBe('R2')
  })

  it('sends an empty code list for a clean row, so the server only checks what the row declares', () => {
    expect(upsertFixtureArgs(row({ source_row: 7 }), 'run-1', issues, 'f-7').warning_codes).toBe('[]')
  })

  it('keeps every issue on the run with its row, severity and text', () => {
    const records = issueRecords(issues)
    expect(records).toHaveLength(issues.length)
    expect(records[3]).toEqual({ source_row: 2, severity: 'blocking', code: 'team_not_found', field: 'team', message: 'Team unknown', remediation: 'Correct the team' })
    expect(Object.keys(records[0]).sort()).toEqual(['code', 'field', 'message', 'remediation', 'severity', 'source_row'])
  })
})

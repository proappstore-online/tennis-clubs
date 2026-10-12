import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import ImportReview from '../src/pages/ImportReview'
import { fingerprint, latestRun, managerClubs, needsConfirmation, provenanceRows, type ImportRun, type ManagedFixture } from '../src/pages/importReviewLogic'

afterEach(cleanup)

const run = (overrides: Partial<ImportRun>): ImportRun => ({ id: 'run-1', org_id: 'a', kind: 'fixtures', status: 'saved', received_count: 12, saved_count: 11, rejected_count: 1, source_sha256: 'abcdef1234567890abcdef', blocking_count: 0, warning_count: 3, acknowledged_count: 2, created_at: Date.UTC(2026, 2, 1, 2), ...overrides })

const fixture = (overrides: Partial<ManagedFixture>): ManagedFixture => ({ id: 'f1', org_id: 'a', starts_at: '2026-03-07T10:00:00+11:00', time_status: 'confirmed', arrival_at: null, source_row: 2, source_date_raw: '07/03/2026', source_time_raw: '10:00', source_import_run_id: 'run-1', round_label: 'Round 1', status: 'scheduled', home_team_name: 'Blue', away_team_name: 'Red', opponent_name: 'Red', ...overrides })

function appWith(calls: Record<string, unknown>) {
  return { actions: { call: vi.fn(async (name: string) => {
    const reply = calls[name]
    if (reply instanceof Error) throw reply
    return reply ?? { rows: [] }
  }) } } as never
}

const manager = { id: 'a', name: 'Club A', role: 'manager' }

describe('import review', () => {
  it('shows the latest stored counts, the source fingerprint and where each fixture came from', async () => {
    render(<ImportReview app={appWith({
      list_my_clubs: { rows: [manager] },
      list_import_reports: { rows: [run({}), run({ id: 'run-0', kind: 'roster', source_sha256: '0123456789abcdef', received_count: 4, saved_count: 4, rejected_count: 0, warning_count: 0, acknowledged_count: 0 })] },
      list_managed_fixtures: { rows: [fixture({}), fixture({ id: 'f2', source_row: 3, source_time_raw: '', time_status: 'tbc', starts_at: '2026-03-08T00:00:00+11:00' })] },
    })} />)
    expect(await screen.findAllByText('Rows received')).toHaveLength(2)
    expect(screen.getByText('abcdef123456')).toBeTruthy()
    expect(screen.getByText(/Source line 2 · Date as imported: 07\/03\/2026 · Start as imported: 10:00/)).toBeTruthy()
    expect(screen.getByText(/Source line 3 · Date as imported: 07\/03\/2026 · Start as imported: —/)).toBeTruthy()
    expect(screen.getByText('Needs confirmation')).toBeTruthy()
    expect(screen.getByText(/1 with an estimated or TBC start time/)).toBeTruthy()
    expect(screen.getByText(/Approving an ambiguous value before members see it is not available yet/)).toBeTruthy()
  })

  it('tells the manager when a kind of report has not been recorded', async () => {
    render(<ImportReview app={appWith({ list_my_clubs: { rows: [manager] }, list_import_reports: { rows: [] }, list_managed_fixtures: { rows: [] } })} />)
    expect(await screen.findByText('No fixture book import has been recorded for this club.')).toBeTruthy()
    expect(screen.getByText('No roster import has been recorded for this club.')).toBeTruthy()
    expect(screen.getByText('No fixtures have been imported for this club yet.')).toBeTruthy()
  })

  it('refuses the page to members who manage no club', async () => {
    render(<ImportReview app={appWith({ list_my_clubs: { rows: [{ id: 'a', name: 'Club A', role: 'player' }] } })} />)
    expect(await screen.findByText('Import review is for club managers, convenors and admins.')).toBeTruthy()
    expect(screen.queryByText('Rows received')).toBeNull()
  })

  it('reports a failed report load instead of an empty result', async () => {
    render(<ImportReview app={appWith({ list_my_clubs: { rows: [manager] }, list_import_reports: new Error('boom'), list_managed_fixtures: { rows: [] } })} />)
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Import reports could not be loaded for this club.')
  })
})

describe('import review logic', () => {
  it('keeps only manager roles and picks the newest run of each kind', () => {
    expect(managerClubs([{ id: 'a', name: 'A', role: 'admin' }, { id: 'b', name: 'B', role: 'player' }, { id: 'c', name: 'C', role: 'convenor' }]).map((club) => club.id)).toEqual(['a', 'c'])
    const runs = [run({ id: 'new-fixtures' }), run({ id: 'new-roster', kind: 'roster' }), run({ id: 'old-fixtures' })]
    expect(latestRun(runs, 'fixtures')?.id).toBe('new-fixtures')
    expect(latestRun(runs, 'roster')?.id).toBe('new-roster')
  })

  it('limits provenance to one club and run, in source line order', () => {
    const rows = provenanceRows([fixture({ id: 'x', source_row: 5 }), fixture({ id: 'y', source_row: 2 }), fixture({ id: 'z', org_id: 'b' }), fixture({ id: 'w', source_import_run_id: 'other' })], 'a', 'run-1')
    expect(rows.map((item) => item.id)).toEqual(['y', 'x'])
  })

  it('flags only estimated and TBC times and shows a placeholder for a missing fingerprint', () => {
    expect(needsConfirmation('estimated')).toBe(true)
    expect(needsConfirmation('tbc')).toBe(true)
    expect(needsConfirmation('confirmed')).toBe(false)
    expect(needsConfirmation(null)).toBe(false)
    expect(fingerprint(null)).toBe('not recorded')
  })
})

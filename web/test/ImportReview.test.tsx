import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import ImportReview from '../src/pages/ImportReview'
import { approvalLabel, awaitingReview, fingerprint, latestRun, managerClubs, needsConfirmation, provenanceRows, type ImportRun, type ManagedFixture } from '../src/pages/importReviewLogic'

afterEach(cleanup)

const run = (overrides: Partial<ImportRun>): ImportRun => ({ id: 'run-1', org_id: 'a', kind: 'fixtures', status: 'saved', received_count: 12, saved_count: 11, rejected_count: 1, source_sha256: 'abcdef1234567890abcdef', blocking_count: 0, warning_count: 3, acknowledged_count: 2, created_at: Date.UTC(2026, 2, 1, 2), ...overrides })

const fixture = (overrides: Partial<ManagedFixture>): ManagedFixture => ({ id: 'f1', org_id: 'a', starts_at: '2026-03-07T10:00:00+11:00', time_status: 'confirmed', arrival_at: null, source_row: 2, source_date_raw: '07/03/2026', source_time_raw: '10:00', source_import_run_id: 'run-1', round_label: 'Round 1', status: 'scheduled', home_team_name: 'Blue', away_team_name: 'Red', opponent_name: 'Red', review_status: 'auto_approved', reviewed_at: null, reviewed_by_name: null, ...overrides })

const awaiting = (overrides: Partial<ManagedFixture> = {}) => fixture({ id: 'f2', source_row: 3, source_time_raw: '', time_status: 'tbc', starts_at: '2026-03-08T00:00:00+11:00', review_status: 'needs_review', ...overrides })

function appWith(calls: Record<string, unknown>) {
  return { actions: { call: vi.fn(async (name: string) => {
    const reply = calls[name]
    if (reply instanceof Error) throw reply
    return reply ?? { rows: [] }
  }) } } as never
}

// A manager's view that changes when a fixture is approved, as the server would.
function reviewApp(initial: ManagedFixture[], approve: () => Promise<unknown> | unknown = () => ({ changes: 1 }), audit: () => Promise<unknown> | unknown = () => ({ changes: 1 })) {
  let fixtures = initial
  const calls: Array<{ name: string; values: Record<string, unknown> }> = []
  const app = { actions: { call: vi.fn(async (name: string, values: Record<string, unknown> = {}) => {
    calls.push({ name, values })
    if (name === 'list_my_clubs') return { rows: [manager] }
    if (name === 'list_import_reports') return { rows: [run({})] }
    if (name === 'list_managed_fixtures') return { rows: fixtures }
    if (name === 'approve_fixture_review') {
      const reply = await approve() as { changes: number }
      if (reply.changes > 0) fixtures = fixtures.map((item) => item.id === values.fixture_id ? { ...item, review_status: 'approved' as const, reviewed_at: 1000, reviewed_by_name: 'Convenor A' } : item)
      return reply
    }
    if (name === 'record_audit_event') return audit()
    return { rows: [] }
  }) } } as never
  return { app, calls }
}

const manager = { id: 'a', name: 'Club A', role: 'manager' }
const approveButton = () => screen.getByRole('button', { name: 'Approve Blue vs Red, source line 3' })

describe('import review', () => {
  it('shows the latest stored counts, the source fingerprint and where each fixture came from', async () => {
    render(<ImportReview app={appWith({
      list_my_clubs: { rows: [manager] },
      list_import_reports: { rows: [run({}), run({ id: 'run-0', kind: 'roster', source_sha256: '0123456789abcdef', received_count: 4, saved_count: 4, rejected_count: 0, warning_count: 0, acknowledged_count: 0 })] },
      list_managed_fixtures: { rows: [fixture({}), awaiting()] },
    })} />)
    expect(await screen.findAllByText('Rows received')).toHaveLength(2)
    expect(screen.getByText('abcdef123456')).toBeTruthy()
    expect(screen.getByText(/Source line 2 · Date as imported: 07\/03\/2026 · Start as imported: 10:00/)).toBeTruthy()
    expect(screen.getByText(/Source line 3 · Date as imported: 07\/03\/2026 · Start as imported: —/)).toBeTruthy()
    expect(screen.getByText('Needs review')).toBeTruthy()
    expect(screen.getByText(/2 fixtures from the latest fixture book, 1 waiting for review/)).toBeTruthy()
    expect(screen.getByText('Hidden from members until approved')).toBeTruthy()
  })

  it('offers approval only for fixtures awaiting review', async () => {
    const approvedAlready = awaiting({ id: 'f3', source_row: 4, away_team_name: 'Gold', opponent_name: 'Gold', review_status: 'approved', reviewed_at: Date.UTC(2026, 2, 2), reviewed_by_name: 'Convenor A' })
    render(<ImportReview app={reviewApp([fixture({}), awaiting(), approvedAlready]).app} />)
    expect(await screen.findByRole('button', { name: 'Approve Blue vs Red, source line 3' })).toBeTruthy()
    expect(screen.getAllByRole('button', { name: /^Approve / })).toHaveLength(1)
    expect(screen.getByText(/Approved by Convenor A on/)).toBeTruthy()
  })

  it('approves one fixture, audits the approval and then shows the fixture as approved', async () => {
    const { app, calls } = reviewApp([awaiting()])
    render(<ImportReview app={app} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Approve Blue vs Red, source line 3' }))
    expect(await screen.findByText('Fixture approved. Members can now see it.')).toBeTruthy()
    expect(calls.find((call) => call.name === 'approve_fixture_review')?.values).toEqual({ fixture_id: 'f2' })
    const audit = calls.find((call) => call.name === 'record_audit_event')?.values
    expect(audit).toMatchObject({ org_id: 'a', action: 'approve_fixture_review', target_type: 'fixture', target_id: 'f2', outcome: 'succeeded' })
    expect(screen.queryByRole('button', { name: /^Approve / })).toBeNull()
    expect(screen.getByText(/Approved by Convenor A on/)).toBeTruthy()
    expect(screen.getByText('No fixtures need review.')).toBeTruthy()
  })

  it('reports a refused approval and audits the refusal without marking the fixture approved', async () => {
    const { app, calls } = reviewApp([awaiting()], () => ({ changes: 0 }))
    render(<ImportReview app={app} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Approve Blue vs Red, source line 3' }))
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'This fixture was not approved. It may already be approved, or its import has blocking conflicts.')
    expect(calls.find((call) => call.name === 'record_audit_event')?.values).toMatchObject({ outcome: 'refused' })
    expect(approveButton()).toBeTruthy()
  })

  it('reports a failed approval as a failure, not as a success, and audits it as refused', async () => {
    const { app, calls } = reviewApp([awaiting()], () => Promise.reject(new Error('network')))
    render(<ImportReview app={app} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Approve Blue vs Red, source line 3' }))
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'The approval could not be saved. Try again.')
    expect(calls.find((call) => call.name === 'record_audit_event')?.values).toMatchObject({ outcome: 'refused' })
    expect(approveButton()).toBeTruthy()
  })

  it('says so when the approval saved but its audit entry did not', async () => {
    const { app } = reviewApp([awaiting()], undefined, () => Promise.reject(new Error('down')))
    render(<ImportReview app={app} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Approve Blue vs Red, source line 3' }))
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Fixture approved, but the audit record could not be written. Tell an administrator.')
  })

  it('shows a loading state while the fixtures load, not an empty result', async () => {
    let finish: (value: unknown) => void = () => {}
    const pending = new Promise((resolve) => { finish = resolve })
    const app = { actions: { call: vi.fn(async (name: string) => {
      if (name === 'list_my_clubs') return { rows: [manager] }
      if (name === 'list_import_reports') return { rows: [run({})] }
      if (name === 'list_managed_fixtures') return pending
      return { rows: [] }
    }) } } as never
    render(<ImportReview app={app} />)
    expect(await screen.findByText('Loading fixtures…')).toBeTruthy()
    expect(screen.queryByText('The latest import has no fixtures you can manage.')).toBeNull()
    finish({ rows: [fixture({})] })
    expect(await screen.findByText(/1 fixtures from the latest fixture book/)).toBeTruthy()
  })

  it('shows an empty state when a fixture book has no fixtures to review', async () => {
    render(<ImportReview app={appWith({ list_my_clubs: { rows: [manager] }, list_import_reports: { rows: [run({})] }, list_managed_fixtures: { rows: [fixture({})] } })} />)
    expect(await screen.findByText('No fixtures need review.')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /^Approve / })).toBeNull()
  })

  it('reports a failed fixture load as an error, not as an empty list', async () => {
    render(<ImportReview app={appWith({ list_my_clubs: { rows: [manager] }, list_import_reports: { rows: [run({})] }, list_managed_fixtures: new Error('boom') })} />)
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Imported fixtures could not be loaded.')
    await waitFor(() => expect(screen.queryByText('The latest import has no fixtures you can manage.')).toBeNull())
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

  it('treats only a needs_review fixture as awaiting review and names the approver of an approved one', () => {
    expect(awaitingReview({ review_status: 'needs_review' })).toBe(true)
    expect(awaitingReview({ review_status: 'approved' })).toBe(false)
    expect(awaitingReview({ review_status: 'auto_approved' })).toBe(false)
    expect(approvalLabel({ review_status: 'approved', reviewed_at: Date.UTC(2026, 2, 2, 3), reviewed_by_name: 'Convenor A' })).toMatch(/^Approved by Convenor A on /)
    expect(approvalLabel({ review_status: 'approved', reviewed_at: Date.UTC(2026, 2, 2, 3), reviewed_by_name: null })).toMatch(/^Approved by a manager on /)
    expect(approvalLabel({ review_status: 'auto_approved', reviewed_at: null, reviewed_by_name: null })).toBe('Confirmed time, visible to members')
  })
})

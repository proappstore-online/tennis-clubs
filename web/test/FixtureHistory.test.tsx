import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import FixtureList, { historyParams } from '../src/pages/FixtureList'
import { localDayStart } from '../src/fixtureTime'

afterEach(cleanup)

const row = (overrides: Record<string, unknown> = {}) => ({ id: 'f1', starts_at: '2026-10-20T10:00:00+11:00', time_status: 'confirmed', arrival_at: null, round_label: 'R1', status: 'scheduled', home_score: null, away_score: null, home_team_id: 'home', away_team_id: 'away', season_id: 's1', season_name: '2026', home_team_name: 'Northside', away_team_name: 'Lakeside', venue_name: null, venue_address: null, member_side: 'home', opponent_name: 'Lakeside', is_external_opponent: 0, ...overrides })

// Answers list_my_fixtures from the requested mode, as the server would.
function appFor(rowsForMode: (mode: string) => unknown[]) {
  const call = vi.fn(async (_name: string, params: Record<string, unknown>) => ({ rows: rowsForMode(String(params.mode)) }))
  return { app: { actions: { call } } as never, call }
}

const upcomingRow = row({ id: 'up', home_team_name: 'Northside', starts_at: '2026-10-20T10:00:00+11:00' })
const pastRows = [row({ id: 'p1', home_team_name: 'Alpha', starts_at: '2026-10-10T10:00:00+11:00', status: 'complete', home_score: 3, away_score: 5 }), row({ id: 'p2', home_team_name: 'Bravo', starts_at: '2026-09-01T10:00:00+10:00', status: 'forfeit' })]

describe('fixtures history', () => {
  it('shows Upcoming selected by default and asks the server for upcoming fixtures', async () => {
    const { app, call } = appFor((mode) => mode === 'upcoming' ? [upcomingRow] : pastRows)
    render(<FixtureList app={app} />)
    expect(screen.getByRole('tab', { name: 'Upcoming' }).getAttribute('aria-selected')).toBe('true')
    expect(await screen.findByRole('heading', { name: 'Northside vs Lakeside' })).toBeTruthy()
    expect(call).toHaveBeenLastCalledWith('list_my_fixtures', expect.objectContaining({ mode: 'upcoming', team_id: '', season_id: '', result_status: '', date_from: '', to: '' }))
  })

  it('switches to Past and reloads with the past mode', async () => {
    const { app, call } = appFor((mode) => mode === 'upcoming' ? [upcomingRow] : pastRows)
    render(<FixtureList app={app} />)
    await screen.findByRole('heading', { name: 'Northside vs Lakeside' })
    fireEvent.click(screen.getByRole('tab', { name: 'Past' }))
    expect(await screen.findByRole('heading', { name: 'Alpha vs Lakeside' })).toBeTruthy()
    expect(screen.getByRole('tab', { name: 'Past' }).getAttribute('aria-selected')).toBe('true')
    expect(screen.queryByRole('heading', { name: 'Northside vs Lakeside' })).toBeNull()
    expect(call).toHaveBeenLastCalledWith('list_my_fixtures', expect.objectContaining({ mode: 'past' }))
  })

  it('shows both upcoming and past fixtures under All', async () => {
    const { app, call } = appFor((mode) => mode === 'all' ? [...pastRows.slice(0, 1), upcomingRow] : [])
    render(<FixtureList app={app} />)
    fireEvent.click(screen.getByRole('tab', { name: 'All' }))
    expect(await screen.findByRole('heading', { name: 'Alpha vs Lakeside' })).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Northside vs Lakeside' })).toBeTruthy()
    expect(call).toHaveBeenLastCalledWith('list_my_fixtures', expect.objectContaining({ mode: 'all' }))
  })

  it('filters by team and sends the chosen team to the server', async () => {
    const { app, call } = appFor(() => [upcomingRow])
    render(<FixtureList app={app} />)
    await screen.findByRole('heading', { name: 'Northside vs Lakeside' })
    const team = screen.getByRole('combobox', { name: 'Team' })
    expect(within(team).getByRole('option', { name: 'Northside' })).toBeTruthy()
    fireEvent.change(team, { target: { value: 'home' } })
    await waitFor(() => expect(call).toHaveBeenLastCalledWith('list_my_fixtures', expect.objectContaining({ team_id: 'home' })))
  })

  it('filters by result status and shows the matching statuses', async () => {
    const { app, call } = appFor(() => pastRows)
    render(<FixtureList app={app} />)
    const status = screen.getByRole('combobox', { name: 'Result status' })
    expect(within(status).getByRole('option', { name: 'Complete' })).toBeTruthy()
    expect(within(status).getByRole('option', { name: 'Forfeit' })).toBeTruthy()
    fireEvent.change(status, { target: { value: 'complete' } })
    await waitFor(() => expect(call).toHaveBeenLastCalledWith('list_my_fixtures', expect.objectContaining({ result_status: 'complete' })))
  })

  it('keeps past fixtures in the order the server returns them, newest first', async () => {
    const { app } = appFor((mode) => mode === 'past' ? pastRows : [])
    render(<FixtureList app={app} />)
    fireEvent.click(screen.getByRole('tab', { name: 'Past' }))
    await screen.findByRole('heading', { name: 'Alpha vs Lakeside' })
    const titles = screen.getAllByRole('heading', { level: 2 }).map((heading) => heading.textContent)
    expect(titles).toEqual(['Alpha vs Lakeside', 'Bravo vs Lakeside'])
  })

  it('explains an empty past view and clears filters back to the defaults', async () => {
    const { app, call } = appFor(() => [])
    render(<FixtureList app={app} />)
    fireEvent.click(screen.getByRole('tab', { name: 'Past' }))
    expect(await screen.findByText('No past fixtures are available for your teams.')).toBeTruthy()
    fireEvent.change(screen.getByRole('combobox', { name: 'Result status' }), { target: { value: 'complete' } })
    expect(await screen.findByText('No fixtures match these filters.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }))
    await waitFor(() => expect(call).toHaveBeenLastCalledWith('list_my_fixtures', expect.objectContaining({ mode: 'past', result_status: '' })))
  })
})

describe('history request parameters', () => {
  const base = { mode: 'all' as const, teamId: '', seasonId: '', resultStatus: '', dateFrom: '', dateTo: '' }

  it('uses local midnight for an inclusive from date and an exclusive day after the to date', () => {
    const params = historyParams({ ...base, dateFrom: '2026-10-01', dateTo: '2026-10-11' }, new Date(2026, 9, 18, 12))
    expect(params.date_from).toBe(new Date(2026, 9, 1).toISOString())
    expect(params.to).toBe(new Date(2026, 9, 12).toISOString())
  })

  it('sends the mode boundary as today and no date range when none is chosen', () => {
    const params = historyParams({ ...base, mode: 'past' }, new Date(2026, 9, 18, 16, 48))
    expect(params.from).toBe(new Date(2026, 9, 18).toISOString())
    expect(params).toMatchObject({ mode: 'past', date_from: '', to: '', team_id: '', season_id: '', result_status: '' })
  })

  it('offsets local day starts by whole days', () => {
    expect(localDayStart('2026-10-01', 1)).toBe(new Date(2026, 9, 2).toISOString())
  })
})

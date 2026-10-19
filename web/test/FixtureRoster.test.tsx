import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

const { authState, mockApp, fixtureState, rosterState, activityState } = vi.hoisted(() => {
  const fixture = {
    id: 'fixture-local', org_id: 'org-local', home_team_id: 'team-home', away_team_id: 'team-away', starts_at: '2027-03-14T09:00:00+11:00', round_label: 'Round 1',
    status: 'scheduled', status_updated_at: null, match_notice: null, home_score: null,
    away_score: null, home_team_name: 'Northside', away_team_name: 'Lakeside',
    in_count: 1, out_count: 0, pending_count: 1, division_name: 'Juniors',
    venue_name: 'Local courts', venue_address: null, venue_notes: null, map_url: null,
    my_availability: 'pending' as 'in' | 'out' | 'pending',
  }
  const roster = [
    { user_id: 'player-1', display_name: 'Sam Player', availability: 'pending' as 'in' | 'out' | 'pending', updated_at: 1_800_000_000 },
  ]
  const activity: { user_id: string; display_name: string; action: string; old_availability: string | null; new_availability: string | null; created_at: number }[] = []
  const mockApp = {
    auth: { signIn: vi.fn(), user: { id: 'manager-1' as string | null, login: 'local@example.test' } },
    roles: { check: vi.fn() },
    storage: { uploadForReview: vi.fn(), downloadForReview: vi.fn() },
    actions: { call: vi.fn() },
  }
  return { authState: { user: { id: 'manager-1', login: 'local@example.test' }, loading: false }, mockApp, fixtureState: fixture, rosterState: roster, activityState: activity }
})

vi.mock('@proappstore/sdk', async () => {
  const React = await import('react')
  return {
    initPro: () => mockApp,
    useAuth: () => ({ ...authState, signOut: vi.fn() }),
    ProShell: ({ children }: { children: React.ReactNode }) => React.createElement('div', null, children),
    PageHeader: ({ title }: { title: string }) => React.createElement('h1', null, title),
  }
})

import App from '../src/App'
import RosterAdmin from '../src/pages/RosterAdmin'

function mockActions() {
  mockApp.actions.call.mockImplementation(async (name: string, values: Record<string, unknown>) => {
    if (name === 'list_managed_fixtures') return { rows: [fixtureState] }
    if (name === 'list_my_fixtures') return { rows: [fixtureState] }
    if (name === 'list_managed_fixture_roster' || name === 'list_fixture_roster') return { rows: rosterState }
    if (name === 'list_fixture_team_candidates') return { rows: [{ user_id: 'player-1', display_name: 'Sam Player' }, { user_id: 'player-2', display_name: 'Alex Player' }] }
    if (name === 'list_fixture_roster_activity') return { rows: activityState }
    if (name === 'list_fixture_result_history' || name === 'list_managed_fixture_results') return { rows: [] }
    if (name === 'set_my_fixture_availability') { fixtureState.my_availability = values.availability as 'in' | 'out' | 'pending'; rosterState[0].availability = values.availability as 'in' | 'out' | 'pending'; return {} }
    if (name === 'add_fixture_roster_player') { rosterState.push({ user_id: 'player-2', display_name: 'Alex Player', availability: 'pending', updated_at: null }); fixtureState.pending_count += 1; return {} }
    if (name === 'remove_fixture_roster_player') { rosterState.splice(0, rosterState.length, ...rosterState.filter((row) => row.user_id !== 'player-2')); return {} }
    return {}
  })
}

describe('fixture roster flows with isolated local fixtures', () => {
  beforeEach(() => {
    window.history.replaceState({}, '', '/')
    authState.user = { id: 'manager-1', login: 'local@example.test' }
    mockApp.auth.user = { id: 'manager-1', login: 'local@example.test' }
    Object.assign(fixtureState, { in_count: 1, out_count: 0, pending_count: 1, my_availability: 'pending', member_side: null, is_external_opponent: null, opponent_name: null, away_team_name: 'Lakeside' })
    rosterState.splice(0, rosterState.length, { user_id: 'player-1', display_name: 'Sam Player', availability: 'pending', updated_at: 1_800_000_000 })
    activityState.splice(0)
    mockApp.actions.call.mockReset()
    mockActions()
  })
  afterEach(cleanup)

  it('shows managed reply counts, timestamps, and roster controls to the authorized manager', async () => {
    window.history.replaceState({}, '', '/rosters')
    render(<App />)
    expect(await screen.findByText('Fixture rosters')).toBeTruthy()
    expect(await screen.findByText('Sam Player')).toBeTruthy()
    expect(screen.getAllByText('1', { selector: 'p' })).toHaveLength(2)
    expect(screen.getByText(/Not sure \/ pending · Updated/)).toBeTruthy()
    fireEvent.change(screen.getByRole('combobox', { name: 'Player to add' }), { target: { value: 'player-2' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add to roster' }))
    await waitFor(() => expect(mockApp.actions.call).toHaveBeenCalledWith('add_fixture_roster_player', { fixture_id: 'fixture-local', user_id: 'player-2', selection: 'selected' }))
    await waitFor(() => expect(mockApp.actions.call).toHaveBeenCalledWith('log_fixture_roster_added', { fixture_id: 'fixture-local', user_id: 'player-2' }))
  })

  it('links the selected fixture to a clearly named result entry section for the manager', async () => {
    window.history.replaceState({}, '', '/rosters')
    render(<App />)
    const link = await screen.findByRole('link', { name: 'Enter or correct the result for this fixture' })
    expect(link.getAttribute('href')).toBe('#fixture-result')
    expect(screen.getByRole('heading', { name: 'Enter or correct the result' })).toBeTruthy()
  })

  it('labels the member team and an external opponent on the player card', async () => {
    authState.user = { id: 'player-1', login: 'player@example.test' }
    mockApp.auth.user = { id: 'player-1', login: 'player@example.test' }
    Object.assign(fixtureState, { member_side: 'home', is_external_opponent: 1, opponent_name: 'Rival Club', away_team_name: 'Rival Club' })
    render(<App />)
    expect(await screen.findByText('Your team: Northside')).toBeTruthy()
    expect(screen.getByText('Opponent (external): Rival Club')).toBeTruthy()
  })

  it('shows the squad separately from the players selected for this fixture', async () => {
    const base = mockApp.actions.call.getMockImplementation()!
    mockApp.actions.call.mockImplementation(async (name: string, values: Record<string, unknown>) =>
      name === 'list_team_pool' && values.team_id === 'team-home'
        ? { rows: [{ team_id: 'team-home', user_id: 'emer-1', display_name: 'Emma Emergency', pool: 'emergency', is_active: 1, updated_at: null }] }
        : base(name, values))
    window.history.replaceState({}, '', '/rosters')
    render(<App />)
    expect(await screen.findByText('Emma Emergency')).toBeTruthy()
    expect(screen.getByText('Emergency pool')).toBeTruthy()
    expect(screen.getByText('Sam Player')).toBeTruthy()
  })

  it('records each managed roster change in the audit trail', async () => {
    window.history.replaceState({}, '', '/rosters')
    render(<App />)
    expect(await screen.findByText('Sam Player')).toBeTruthy()
    fireEvent.change(screen.getByRole('combobox', { name: 'Player to add' }), { target: { value: 'player-2' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add to roster' }))
    await waitFor(() => expect(mockApp.actions.call).toHaveBeenCalledWith('record_audit_event', expect.objectContaining({ org_id: 'org-local', action: 'add_fixture_roster_player', target_id: 'fixture-local:player-2', outcome: 'succeeded' })))
  })

  it('gives a player only their own in, out, or not sure reply controls', async () => {
    authState.user = { id: 'player-1', login: 'player@example.test' }
    mockApp.auth.user = { id: 'player-1', login: 'player@example.test' }
    render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: /Northside.*Lakeside/ }))
    expect(screen.getByRole('button', { name: 'I’m out' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Not sure' })).toBeTruthy()
    fireEvent.click(await screen.findByRole('button', { name: 'I’m in' }))
    await waitFor(() => expect(mockApp.actions.call).toHaveBeenCalledWith('set_my_fixture_availability', { fixture_id: 'fixture-local', availability: 'in' }))
    await waitFor(() => expect(mockApp.actions.call).toHaveBeenCalledWith('log_my_fixture_availability_change', { fixture_id: 'fixture-local', old_availability: 'pending', new_availability: 'in' }))
    expect(screen.getByText('Sam Player')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Add to roster' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'I’m out' }))
    await waitFor(() => expect(mockApp.actions.call).toHaveBeenCalledWith('set_my_fixture_availability', { fixture_id: 'fixture-local', availability: 'out' }))
    fireEvent.click(screen.getByRole('button', { name: 'Not sure' }))
    await waitFor(() => expect(mockApp.actions.call).toHaveBeenCalledWith('set_my_fixture_availability', { fixture_id: 'fixture-local', availability: 'pending' }))
  })

  it('does not report a refused roster addition as added', async () => {
    const base = mockApp.actions.call.getMockImplementation()!
    mockApp.actions.call.mockImplementation(async (name: string, values: Record<string, unknown>) =>
      name === 'add_fixture_roster_player' ? { changes: 0 } : base(name, values))
    window.history.replaceState({}, '', '/rosters')
    render(<App />)
    expect(await screen.findByText('Sam Player')).toBeTruthy()
    fireEvent.change(screen.getByRole('combobox', { name: 'Player to add' }), { target: { value: 'player-2' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add to roster' }))
    expect(await screen.findByText('The roster change could not be saved.')).toBeTruthy()
    expect(screen.queryByText('Player added to the fixture roster.')).toBeNull()
    expect(mockApp.actions.call).not.toHaveBeenCalledWith('log_fixture_roster_added', expect.anything())
  })

  it('sends an emergency pool player as a call-up when the roster opens on them', async () => {
    const base = mockApp.actions.call.getMockImplementation()!
    mockApp.actions.call.mockImplementation(async (name: string, values: Record<string, unknown>) =>
      name === 'list_fixture_team_candidates' ? { rows: [{ user_id: 'emer-1', display_name: 'Emma Emergency', pool: 'emergency' }] } : base(name, values))
    window.history.replaceState({}, '', '/rosters')
    render(<App />)
    expect(await screen.findByText('Sam Player')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Add to roster' }))
    await waitFor(() => expect(mockApp.actions.call).toHaveBeenCalledWith('add_fixture_roster_player', { fixture_id: 'fixture-local', user_id: 'emer-1', selection: 'emergency_call_up' }))
  })

  it('does not show a player reply as saved when no roster row was changed', async () => {
    authState.user = { id: 'player-1', login: 'player@example.test' }
    mockApp.auth.user = { id: 'player-1', login: 'player@example.test' }
    const base = mockApp.actions.call.getMockImplementation()!
    mockApp.actions.call.mockImplementation(async (name: string, values: Record<string, unknown>) =>
      name === 'set_my_fixture_availability' ? { changes: 0 } : base(name, values))
    render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: /Northside.*Lakeside/ }))
    fireEvent.click(await screen.findByRole('button', { name: 'I’m in' }))
    expect(await screen.findByText('Your availability was not saved. You may not be on this fixture’s roster yet.')).toBeTruthy()
    expect(mockApp.actions.call).not.toHaveBeenCalledWith('log_my_fixture_availability_change', expect.anything())
  })

  it('shows actionable feedback and no management controls when the account has no managed fixtures', async () => {
    mockApp.actions.call.mockImplementation(async (name: string) => name === 'list_managed_fixtures' ? { rows: [] } : {})
    window.history.replaceState({}, '', '/rosters')
    render(<RosterAdmin app={mockApp as never} />)
    expect(await screen.findByText('No fixtures are available to manage.')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Add to roster' })).toBeNull()
  })
})

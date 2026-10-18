import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import FixtureList from '../src/pages/FixtureList'
import { fixturesLoadMessage } from '../src/pages/fixtureListMessages'
import { fixtureListStart } from '../src/fixtureTime'

afterEach(cleanup)

const fixture = (overrides: Record<string, unknown> = {}) => ({ id: 'f1', starts_at: '2026-05-16T15:00:00+10:00', time_status: 'confirmed', arrival_at: null, round_label: 'R1', home_team_name: 'Northside', away_team_name: 'Lakeside', venue_name: 'Central Courts', venue_address: null, member_side: 'home', opponent_name: 'Lakeside', is_external_opponent: 0, ...overrides })

// The server applies the review gate; the page shows exactly the rows it returns.
function appReturning(reply: unknown) {
  return { actions: { call: vi.fn(async () => {
    if (reply instanceof Error) throw reply
    return reply
  }) } } as never
}

describe('member fixtures', () => {
  it('shows the fixtures the server returns for the member teams', async () => {
    render(<FixtureList app={appReturning({ rows: [fixture()] })} />)
    expect(await screen.findByRole('heading', { name: 'Northside vs Lakeside' })).toBeTruthy()
    expect(screen.getByText('Your team: Northside')).toBeTruthy()
  })

  it('uses the start of today so a scheduled morning fixture remains visible later in the day', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 9, 18, 16, 48))
    expect(fixtureListStart()).toBe(new Date(2026, 9, 18).toISOString())
    vi.useRealTimers()
  })

  it('labels the member team and the opponent separately, marking an external club', async () => {
    render(<FixtureList app={appReturning({ rows: [fixture({ member_side: 'home', opponent_name: 'Rival Club', is_external_opponent: 1, away_team_name: 'Rival Club' })] })} />)
    expect(await screen.findByText('Your team: Northside')).toBeTruthy()
    expect(screen.getByText('Opponent: Rival Club (external club)')).toBeTruthy()
  })

  it('shows the opponent for an away member without marking an internal team as external', async () => {
    render(<FixtureList app={appReturning({ rows: [fixture({ member_side: 'away', opponent_name: 'Northside', is_external_opponent: 0 })] })} />)
    expect(await screen.findByText('Your team: Lakeside')).toBeTruthy()
    expect(screen.getByText('Opponent: Northside')).toBeTruthy()
  })

  it('shows a loading state until the fixtures arrive', async () => {
    let finish: (value: unknown) => void = () => {}
    const pending = new Promise((resolve) => { finish = resolve })
    render(<FixtureList app={{ actions: { call: vi.fn(() => pending) } } as never} />)
    expect(screen.getByRole('status')).toHaveProperty('textContent', 'Loading fixtures…')
    finish({ rows: [] })
    expect(await screen.findByText('No upcoming fixtures are available for your teams.')).toBeTruthy()
  })

  it('shows an empty state when the member has no upcoming fixtures', async () => {
    render(<FixtureList app={appReturning({ rows: [] })} />)
    expect(await screen.findByText('No upcoming fixtures are available for your teams.')).toBeTruthy()
  })

  it('shows a load failure without claiming there are no fixtures', async () => {
    render(<FixtureList app={appReturning(new Error('boom'))} />)
    expect(await screen.findByText('Fixtures could not be loaded for your teams.')).toBeTruthy()
    expect(screen.queryByText('No upcoming fixtures are available for your teams.')).toBeNull()
  })

  it('asks a signed-out or unauthorised member to sign in, rather than showing a generic failure', async () => {
    render(<FixtureList app={appReturning(Object.assign(new Error('forbidden'), { status: 403 }))} />)
    expect(await screen.findByText('Sign in with the account that belongs to your team to see its fixtures.')).toBeTruthy()
    expect(screen.queryByText('No upcoming fixtures are available for your teams.')).toBeNull()
  })
})

describe('fixture load messages', () => {
  it('maps refused reads to a sign-in message and anything else to a plain failure', () => {
    expect(fixturesLoadMessage({ status: 401 })).toBe('Sign in with the account that belongs to your team to see its fixtures.')
    expect(fixturesLoadMessage({ status: 403 })).toBe('Sign in with the account that belongs to your team to see its fixtures.')
    expect(fixturesLoadMessage({ status: 500 })).toBe('Fixtures could not be loaded for your teams.')
    expect(fixturesLoadMessage(new Error('network'))).toBe('Fixtures could not be loaded for your teams.')
    expect(fixturesLoadMessage(null)).toBe('Fixtures could not be loaded for your teams.')
  })
})

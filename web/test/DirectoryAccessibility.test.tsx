import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import FixtureList from '../src/pages/FixtureList'
import { COMPS_LIMIT, Comps } from '../src/App'

// Keyboard and screen-reader behaviour of the directory (Comps) and fixture pages (issue #32).
const { mockApp } = vi.hoisted(() => ({ mockApp: { auth: { signIn: vi.fn(), user: null }, actions: { call: vi.fn() } } }))

vi.mock('@proappstore/sdk', async () => {
  const React = await import('react')
  return {
    initPro: () => mockApp,
    useAuth: () => ({ user: null, loading: false, signOut: vi.fn() }),
    ProShell: ({ children }: { children: ReactNode }) => React.createElement('div', null, children),
    PageHeader: ({ title }: { title: string }) => React.createElement('h1', null, title),
  }
})
vi.mock('../src/pages/ClubAdmin', () => ({ default: () => null }))
vi.mock('../src/pages/RosterAdmin', () => ({ default: () => null }))
vi.mock('../src/pages/FixtureImport', () => ({ default: () => null }))
vi.mock('../src/pages/DocumentLibrary', () => ({ default: () => null }))
vi.mock('../src/pages/ImportReview', () => ({ default: () => null }))

afterEach(cleanup)

const fixture = (overrides: Record<string, unknown> = {}) => ({ id: 'f1', starts_at: '2026-05-16T15:00:00+10:00', time_status: 'confirmed', arrival_at: null, round_label: 'R1', status: 'scheduled', home_score: null, away_score: null, status_updated_at: null, match_notice: null, home_team_name: 'Northside', away_team_name: 'Lakeside', home_team_id: 'h', away_team_id: 'a', season_id: null, season_name: null, venue_name: 'Central Courts', venue_address: null, venue_notes: null, map_url: null, division_name: null, member_side: 'home', opponent_name: 'Lakeside', is_external_opponent: 0, my_availability: 'pending', ...overrides })

describe('fixture period tabs', () => {
  it('moves between periods with the arrow, Home and End keys, and moves focus with the selection', async () => {
    mockApp.actions.call.mockResolvedValue({ rows: [] })
    render(<FixtureList app={mockApp as never} />)
    await screen.findByText('No upcoming fixtures are available for your teams.')

    const upcoming = screen.getByRole('tab', { name: 'Upcoming' })
    upcoming.focus()
    fireEvent.keyDown(upcoming, { key: 'ArrowRight' })
    expect(screen.getByRole('tab', { name: 'Past' }).getAttribute('aria-selected')).toBe('true')
    expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'Past' }))

    fireEvent.keyDown(document.activeElement!, { key: 'End' })
    expect(screen.getByRole('tab', { name: 'All' }).getAttribute('aria-selected')).toBe('true')

    fireEvent.keyDown(document.activeElement!, { key: 'ArrowRight' })
    expect(screen.getByRole('tab', { name: 'Upcoming' }).getAttribute('aria-selected')).toBe('true')

    fireEvent.keyDown(document.activeElement!, { key: 'ArrowLeft' })
    expect(screen.getByRole('tab', { name: 'All' }).getAttribute('aria-selected')).toBe('true')

    fireEvent.keyDown(document.activeElement!, { key: 'Home' })
    expect(screen.getByRole('tab', { name: 'Upcoming' }).getAttribute('aria-selected')).toBe('true')
    expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'Upcoming' }))
  }, 20000)
})

describe('fixture list semantics', () => {
  it('renders fixtures as a list of items', async () => {
    mockApp.actions.call.mockResolvedValue({ rows: [fixture(), fixture({ id: 'f2', home_team_name: 'Hillside', away_team_name: 'Coastal' })] })
    render(<FixtureList app={mockApp as never} />)
    expect(await screen.findByRole('list')).toBeTruthy()
    expect(screen.getAllByRole('listitem')).toHaveLength(2)
  })

  it('announces a load failure as an alert', async () => {
    mockApp.actions.call.mockRejectedValue(new Error('offline'))
    render(<FixtureList app={mockApp as never} />)
    expect((await screen.findByRole('alert')).textContent).toBeTruthy()
  })
})

describe('fixture dialog on the directory page', () => {
  function openDialog() {
    mockApp.actions.call.mockImplementation(async (name: string) => (name === 'list_my_fixtures' ? { rows: [fixture()] } : { rows: [] }))
    render(<Comps user={{ id: 'u1', login: 'sam' }} onSignOut={() => {}} />)
    return screen.findByRole('button', { name: /Northside vs Lakeside/ })
  }

  it('is a named modal dialog that moves focus in, marks the current availability, and labels the close button', async () => {
    const card = await openDialog()
    fireEvent.click(card)
    const dialog = await screen.findByRole('dialog', { name: 'Northside vs Lakeside' })
    expect(dialog.getAttribute('aria-modal')).toBe('true')
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Close fixture details' })))
    expect(screen.getByRole('button', { name: 'Not sure' }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByRole('button', { name: 'I’m in' }).getAttribute('aria-pressed')).toBe('false')
  })

  it('keeps Tab and Shift+Tab inside the dialog', async () => {
    const card = await openDialog()
    fireEvent.click(card)
    await screen.findByRole('dialog')
    const close = screen.getByRole('button', { name: 'Close fixture details' })
    const last = screen.getByRole('button', { name: 'Not sure' })
    last.focus()
    fireEvent.keyDown(last, { key: 'Tab' })
    expect(document.activeElement).toBe(close)
    fireEvent.keyDown(close, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(last)
  })

  it('closes on Escape and returns focus to the fixture card that opened it', async () => {
    const card = await openDialog()
    card.focus()
    fireEvent.click(card)
    const dialog = await screen.findByRole('dialog')
    fireEvent.keyDown(dialog, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(document.activeElement).toBe(card)
  })
})

describe('directory truncation', () => {
  it('says when the directory shows only the next fixtures the load limit allows', async () => {
    const rows = Array.from({ length: COMPS_LIMIT }, (_, index) => fixture({ id: `c${index}`, home_team_name: `Home ${index}` }))
    mockApp.actions.call.mockImplementation(async (name: string) => (name === 'list_my_fixtures' ? { rows } : { rows: [] }))
    render(<Comps user={{ id: 'u1', login: 'sam' }} onSignOut={() => {}} />)
    expect(await screen.findByText(`Only your next ${COMPS_LIMIT} fixtures are shown here. Open Fixtures for the full list.`)).toBeTruthy()
  })

  it('shows no limit notice when fewer fixtures than the limit are returned', async () => {
    mockApp.actions.call.mockImplementation(async (name: string) => (name === 'list_my_fixtures' ? { rows: [fixture()] } : { rows: [] }))
    render(<Comps user={{ id: 'u1', login: 'sam' }} onSignOut={() => {}} />)
    await screen.findByRole('button', { name: /Northside vs Lakeside/ })
    expect(screen.queryByText(/Only your next/)).toBeNull()
  })
})

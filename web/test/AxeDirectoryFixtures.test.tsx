import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import axe from 'axe-core'
import FixtureList from '../src/pages/FixtureList'
import { Comps } from '../src/App'

// Automated accessibility checks (axe) on the directory and fixture pages (issue #32).
// Colour contrast is checked against the design tokens in ContrastTokens.test.ts: jsdom does not
// apply Tailwind classes or lay out the page, so axe's colour-contrast rule cannot judge these pages here.
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

// axe-core rules that depend on rendered layout or colour are excluded here (see the header comment).
const AXE_OPTIONS = { rules: { 'color-contrast': { enabled: false } } }

async function violationsIn(container: HTMLElement) {
  const result = await axe.run(container, AXE_OPTIONS)
  return result.violations.map((violation) => `${violation.id} (${violation.impact}): ${violation.help} — ${violation.nodes.map((node) => node.target.join(' ')).join(', ')}`)
}

describe('axe: fixture page', () => {
  it('has no violations with fixtures listed', async () => {
    mockApp.actions.call.mockResolvedValue({ rows: [fixture(), fixture({ id: 'f2', home_team_name: 'Hillside', away_team_name: 'Coastal', member_side: 'away', opponent_name: 'Hillside' })] })
    const { container } = render(<FixtureList app={mockApp as never} />)
    await screen.findByRole('list')
    expect(await violationsIn(container)).toEqual([])
  })

  it('has no violations in the empty state', async () => {
    mockApp.actions.call.mockResolvedValue({ rows: [] })
    const { container } = render(<FixtureList app={mockApp as never} />)
    await screen.findByText('No upcoming fixtures are available for your teams.')
    expect(await violationsIn(container)).toEqual([])
  })

  it('has no violations with the error alert shown', async () => {
    mockApp.actions.call.mockRejectedValue(new Error('offline'))
    const { container } = render(<FixtureList app={mockApp as never} />)
    await screen.findByRole('alert')
    expect(await violationsIn(container)).toEqual([])
  })
})

describe('axe: directory page', () => {
  it('has no violations with fixtures listed', async () => {
    mockApp.actions.call.mockImplementation(async (name: string) => (name === 'list_my_fixtures' ? { rows: [fixture()] } : { rows: [] }))
    const { container } = render(<Comps user={{ id: 'u1', login: 'sam' }} onSignOut={() => {}} />)
    await screen.findByRole('button', { name: /Northside vs Lakeside/ })
    expect(await violationsIn(container)).toEqual([])
  })

  it('has no violations with the fixture dialog open', async () => {
    mockApp.actions.call.mockImplementation(async (name: string) => (name === 'list_my_fixtures' ? { rows: [fixture()] } : { rows: [{ user_id: 'p1', display_name: 'Alex', availability: 'in', selection: 'selected' }] }))
    const { container } = render(<Comps user={{ id: 'u1', login: 'sam' }} onSignOut={() => {}} />)
    fireEvent.click(await screen.findByRole('button', { name: /Northside vs Lakeside/ }))
    await screen.findByRole('dialog')
    expect(await violationsIn(container)).toEqual([])
  })
})

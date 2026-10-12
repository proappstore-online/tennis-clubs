import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import DocumentLibrary, { visibilityLabel } from '../src/pages/DocumentLibrary'

afterEach(cleanup)

function appWith(calls: Record<string, unknown>) {
  return { actions: { call: vi.fn(async (name: string) => calls[name] ?? { rows: [] }) } } as never
}

const base = { description: null, category: 'guidance', visibility: 'member', source_attribution: 'Committee', effective_on: '2026-03-01', revision: null, expires_on: null, byte_size: 10 }

describe('document library', () => {
  it('labels who can see each document and states that files are not yet available', async () => {
    const app = appWith({
      list_my_clubs: { rows: [{ id: 'a', name: 'Club A', role: 'player' }] },
      list_documents: { rows: [
        { ...base, id: 'd1', title: 'Parent guidance', description: 'Sideline behaviour', status: 'stored' },
        { ...base, id: 'd2', title: 'Roster rules', category: 'roster', visibility: 'team', status: 'registered' },
      ] },
    })
    render(<DocumentLibrary app={app} />)
    expect(await screen.findByText('Parent guidance')).toBeTruthy()
    expect(screen.getByText('Guidance · Club members')).toBeTruthy()
    expect(screen.getByText('File stored; download not yet available')).toBeTruthy()
    expect(screen.getByText('Roster · Team members')).toBeTruthy()
    expect(screen.getByText('File not yet available')).toBeTruthy()
    expect(screen.queryByRole('link', { name: 'Download file' })).toBeNull()
    expect(screen.queryByLabelText('Upload file')).toBeNull()
  })

  it('explains that downloads and uploads depend on the app worker', async () => {
    render(<DocumentLibrary app={appWith({ list_my_clubs: { rows: [] } })} />)
    expect(await screen.findByText(/need an app worker/)).toBeTruthy()
  })

  it('shows an empty state when the caller belongs to no club', async () => {
    render(<DocumentLibrary app={appWith({ list_my_clubs: { rows: [] } })} />)
    expect(await screen.findByText('You are not a member of a club yet.')).toBeTruthy()
  })

  it('maps every visibility level to plain words', () => {
    expect(visibilityLabel('public')).toBe('Anyone signed in')
    expect(visibilityLabel('member')).toBe('Club members')
    expect(visibilityLabel('team')).toBe('Team members')
    expect(visibilityLabel('manager')).toBe('Managers and convenors')
    expect(visibilityLabel('admin')).toBe('Administrators only')
  })
})

describe('document filters and applicability', () => {
  const scoped = [
    { ...base, id: 'd1', title: 'Season rules', category: 'competition', scope_type: 'season', scope_id: 's1', team_id: null, status: 'registered' },
    { ...base, id: 'd2', title: 'Blue team plan', category: 'roster', visibility: 'team', scope_type: 'team', scope_id: 't1', team_id: 't1', status: 'registered' },
    { ...base, id: 'd3', title: 'Club code', category: 'behaviour', visibility: 'public', scope_type: 'club', scope_id: 'a', team_id: null, status: 'stored' },
  ]

  function scopedApp(names: { seasons?: unknown; teams?: unknown }) {
    return { actions: { call: vi.fn(async (name: string, values: Record<string, unknown>) => {
      if (name === 'list_my_clubs') return { rows: [{ id: 'a', name: 'Club A', role: 'manager' }] }
      if (name === 'list_documents') return values.category === 'behaviour' ? { rows: [scoped[2]] } : { rows: scoped }
      if (name === 'list_club_seasons') { if (names.seasons instanceof Error) throw names.seasons; return { rows: names.seasons ?? [] } }
      if (name === 'list_club_teams') { if (names.teams instanceof Error) throw names.teams; return { rows: names.teams ?? [] } }
      return { rows: [] }
    }) } } as never
  }

  it('filters by season and team using the names a manager can read', async () => {
    render(<DocumentLibrary app={scopedApp({ seasons: [{ id: 's1', name: '2026 Winter' }], teams: [{ id: 't1', name: 'Blue' }] })} />)
    expect(await screen.findByText('Season rules')).toBeTruthy()
    expect(screen.getByText('Season: 2026 Winter')).toBeTruthy()
    expect(screen.getByText('Team: Blue')).toBeTruthy()
    expect(screen.getByText('Whole club')).toBeTruthy()
    fireEvent.change(screen.getByLabelText('Season'), { target: { value: 's1' } })
    expect(screen.getByText('Season rules')).toBeTruthy()
    expect(screen.queryByText('Blue team plan')).toBeNull()
    expect(screen.queryByText('Club code')).toBeNull()
    fireEvent.change(screen.getByLabelText('Season'), { target: { value: '' } })
    fireEvent.change(screen.getByLabelText('Team'), { target: { value: 't1' } })
    expect(screen.getByText('Blue team plan')).toBeTruthy()
    expect(screen.queryByText('Season rules')).toBeNull()
  })

  it('uses numbered labels for members who cannot list seasons or teams', async () => {
    render(<DocumentLibrary app={scopedApp({ seasons: new Error('forbidden'), teams: new Error('forbidden') })} />)
    expect(await screen.findByText('Season rules')).toBeTruthy()
    expect(screen.getByText('Season: season document')).toBeTruthy()
    expect(screen.getByText('Team: team document')).toBeTruthy()
    expect(screen.getByRole('option', { name: 'Season 1' })).toBeTruthy()
    expect(screen.getByRole('option', { name: 'Team 1' })).toBeTruthy()
  })

  it('sends the category to the server and reports when filters match nothing', async () => {
    const app = scopedApp({})
    render(<DocumentLibrary app={app} />)
    expect(await screen.findByText('Season rules')).toBeTruthy()
    fireEvent.change(screen.getByLabelText('Category'), { target: { value: 'behaviour' } })
    expect(await screen.findByText('Club code')).toBeTruthy()
    expect(screen.queryByText('Season rules')).toBeNull()
    expect((app as unknown as { actions: { call: ReturnType<typeof vi.fn> } }).actions.call).toHaveBeenCalledWith('list_documents', { org_id: 'a', category: 'behaviour', limit: 100 })
  })

  it('offers a disabled download only for stored files', async () => {
    render(<DocumentLibrary app={scopedApp({})} />)
    expect(await screen.findByText('Club code')).toBeTruthy()
    const buttons = screen.getAllByRole('button', { name: 'Download unavailable' })
    expect(buttons).toHaveLength(1)
    expect((buttons[0] as HTMLButtonElement).disabled).toBe(true)
  })

  it('shows a clear message when a club document list cannot be loaded', async () => {
    const app = { actions: { call: vi.fn(async (name: string) => {
      if (name === 'list_my_clubs') return { rows: [{ id: 'a', name: 'Club A', role: 'player' }] }
      if (name === 'list_documents') throw new Error('denied')
      return { rows: [] }
    }) } } as never
    render(<DocumentLibrary app={app} />)
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Documents could not be loaded for this club.')
  })
})

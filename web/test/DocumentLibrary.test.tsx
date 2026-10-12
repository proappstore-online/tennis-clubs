import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
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

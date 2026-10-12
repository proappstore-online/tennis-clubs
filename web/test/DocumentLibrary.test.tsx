import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import DocumentLibrary, { visibilityLabel } from '../src/pages/DocumentLibrary'

afterEach(cleanup)

function appWith(calls: Record<string, unknown>) {
  return { actions: { call: vi.fn(async (name: string) => calls[name] ?? { rows: [] }) } } as never
}

describe('document library downloads and uploads', () => {
  it('offers the proxied download only for stored files and upload only to managers', async () => {
    const document = { id: 'd9', title: 'Club handbook', description: null, category: 'guidance', visibility: 'member', source_attribution: 'Committee', effective_on: '2026-03-01', revision: null, expires_on: null, byte_size: 10 }
    const docs = { rows: [{ ...document, status: 'stored' }, { ...document, id: 'd10', status: 'registered' }] }
    render(<DocumentLibrary app={appWith({ list_my_clubs: { rows: [{ id: 'a', name: 'Club A', role: 'manager' }] }, list_documents: docs })} />)
    const link = await screen.findByRole('link', { name: 'Download file' })
    expect(link.getAttribute('href')).toBe('/.pas/worker/documents/d9/download?org=a')
    expect(screen.getByLabelText('Upload file')).toBeTruthy()
  })

  it('hides upload from members', async () => {
    const docs = { rows: [{ id: 'd10', title: 'Pending', description: null, category: 'other', visibility: 'member', source_attribution: 'Committee', effective_on: '2026-03-01', revision: null, expires_on: null, byte_size: 10, status: 'registered' }] }
    render(<DocumentLibrary app={appWith({ list_my_clubs: { rows: [{ id: 'a', name: 'Club A', role: 'player' }] }, list_documents: docs })} />)
    expect(await screen.findByText('Pending')).toBeTruthy()
    expect(screen.queryByLabelText('Upload file')).toBeNull()
    expect(screen.queryByRole('link', { name: 'Download file' })).toBeNull()
  })

  it('labels who can see each document and whether its file is available', async () => {
    const app = appWith({
      list_my_clubs: { rows: [{ id: 'a', name: 'Club A', role: 'player' }] },
      list_documents: { rows: [
        { id: 'd1', title: 'Parent guidance', description: 'Sideline behaviour', category: 'guidance', visibility: 'member', source_attribution: 'Committee', effective_on: '2026-03-01', revision: 'v2', expires_on: null, status: 'stored', byte_size: 1024 },
        { id: 'd2', title: 'Roster rules', description: null, category: 'roster', visibility: 'team', source_attribution: 'Coach', effective_on: '2026-04-01', revision: null, expires_on: '2027-01-01', status: 'registered', byte_size: null },
      ] },
    })
    render(<DocumentLibrary app={app} />)
    expect(await screen.findByText('Parent guidance')).toBeTruthy()
    expect(screen.getByText('Guidance · Club members')).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Download file' })).toBeTruthy()
    expect(screen.getByText('Roster · Team members')).toBeTruthy()
    expect(screen.getByText('File not yet uploaded')).toBeTruthy()
    expect(screen.getAllByRole('link', { name: 'Download file' })).toHaveLength(1)
  })

  it('shows an empty state when the caller belongs to no club', async () => {
    render(<DocumentLibrary app={appWith({ list_my_clubs: { rows: [] } })} />)
    expect(await screen.findByText('You are not a member of a club yet.')).toBeTruthy()
  })

  it('maps every visibility level to plain words', () => {
    expect(visibilityLabel('public')).toBe('Anyone signed in')
    expect(visibilityLabel('manager')).toBe('Managers and convenors')
    expect(visibilityLabel('admin')).toBe('Administrators only')
  })
})

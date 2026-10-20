import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import DocumentLibrary, { DOCUMENT_LIMIT, visibilityLabel } from '../src/pages/DocumentLibrary'
import { documentFileProblem, downloadMessage, filenameFrom, uploadMessage } from '../src/pages/documentFile'

afterEach(cleanup)
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

function appWith(calls: Record<string, unknown>) {
  return { actions: { call: vi.fn(async (name: string) => calls[name] ?? { rows: [] }) }, worker: { fetch: vi.fn() } } as never
}

const base = { description: null, category: 'guidance', visibility: 'member', source_attribution: 'Committee', effective_on: '2026-03-01', revision: null, expires_on: null, byte_size: 10 }
const filterGroup = () => within(screen.getByRole('group', { name: 'Filter documents' }))

describe('document library', () => {
  it('labels who can see each document and shows the file status', async () => {
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
    expect(screen.getByText('File available')).toBeTruthy()
    expect(screen.getByText('Roster · Team members')).toBeTruthy()
    expect(screen.getByText('File not yet uploaded')).toBeTruthy()
  })

  it('gives members a download and no upload controls', async () => {
    const app = appWith({
      list_my_clubs: { rows: [{ id: 'a', name: 'Club A', role: 'player' }] },
      list_documents: { rows: [{ ...base, id: 'd1', title: 'Parent guidance', status: 'stored' }, { ...base, id: 'd2', title: 'Roster rules', status: 'registered' }] },
    })
    render(<DocumentLibrary app={app} />)
    expect(await screen.findByRole('button', { name: /^Download / })).toBeTruthy()
    expect(screen.queryByLabelText('Document title')).toBeNull()
    expect(screen.queryByLabelText(/Upload file for/)).toBeNull()
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
    }), }, worker: { fetch: vi.fn() } } as never
  }

  it('filters by season and team using the names a manager can read', async () => {
    render(<DocumentLibrary app={scopedApp({ seasons: [{ id: 's1', name: '2026 Winter' }], teams: [{ id: 't1', name: 'Blue' }] })} />)
    expect(await screen.findByText('Season rules')).toBeTruthy()
    expect(screen.getByText('Season: 2026 Winter')).toBeTruthy()
    expect(screen.getByText('Team: Blue')).toBeTruthy()
    expect(screen.getByText('Whole club')).toBeTruthy()
    fireEvent.change(filterGroup().getByLabelText('Season'), { target: { value: 's1' } })
    expect(screen.getByText('Season rules')).toBeTruthy()
    expect(screen.queryByText('Blue team plan')).toBeNull()
    expect(screen.queryByText('Club code')).toBeNull()
    fireEvent.change(filterGroup().getByLabelText('Season'), { target: { value: '' } })
    fireEvent.change(filterGroup().getByLabelText('Team'), { target: { value: 't1' } })
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
    fireEvent.change(filterGroup().getByLabelText('Category'), { target: { value: 'behaviour' } })
    expect(await screen.findByText('Club code')).toBeTruthy()
    expect(screen.queryByText('Season rules')).toBeNull()
    expect((app as unknown as { actions: { call: ReturnType<typeof vi.fn> } }).actions.call).toHaveBeenCalledWith('list_documents', { org_id: 'a', category: 'behaviour', limit: 100 })
  })

  it('shows a clear message when a club document list cannot be loaded', async () => {
    const app = { actions: { call: vi.fn(async (name: string) => {
      if (name === 'list_my_clubs') return { rows: [{ id: 'a', name: 'Club A', role: 'player' }] }
      if (name === 'list_documents') throw new Error('denied')
      return { rows: [] }
    }) }, worker: { fetch: vi.fn() } } as never
    render(<DocumentLibrary app={app} />)
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Documents could not be loaded for this club.')
  })
})

describe('document downloads', () => {
  const stored = { ...base, id: 'd1', title: 'Parent guidance', status: 'stored' }
  const clubs = { list_my_clubs: { rows: [{ id: 'a', name: 'Club A', role: 'player' }] }, list_documents: { rows: [stored] } }

  it('fetches the file through the worker for an authorised member and saves it under its title', async () => {
    const app = appWith(clubs) as unknown as { worker: { fetch: ReturnType<typeof vi.fn> } }
    app.worker.fetch.mockResolvedValue(new Response('placeholder', { status: 200, headers: { 'content-disposition': 'attachment; filename="Parent guidance"' } }))
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:test'), revokeObjectURL: vi.fn() }))
    const clicked: string[] = []
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) { clicked.push(this.download) })

    render(<DocumentLibrary app={app as never} />)
    fireEvent.click(await screen.findByRole('button', { name: /^Download / }))
    await waitFor(() => expect(clicked).toEqual(['Parent guidance']))
    expect(app.worker.fetch).toHaveBeenCalledWith('/documents/d1/download?org=a')
  })

  it('shows the refusal wording when the worker denies the download', async () => {
    const app = appWith(clubs) as unknown as { worker: { fetch: ReturnType<typeof vi.fn> } }
    app.worker.fetch.mockResolvedValue(new Response('not found', { status: 404 }))
    render(<DocumentLibrary app={app as never} />)
    fireEvent.click(await screen.findByRole('button', { name: /^Download / }))
    expect(await screen.findByText('You cannot download this document, or it is no longer available.')).toBeTruthy()
  })

  it('offers no download for a document whose file is not uploaded', async () => {
    render(<DocumentLibrary app={appWith({ ...clubs, list_documents: { rows: [{ ...stored, status: 'registered' }] } })} />)
    expect(await screen.findByText('File not yet uploaded')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /^Download / })).toBeNull()
  })
})

describe('manager upload', () => {
  const managerClubs = { list_my_clubs: { rows: [{ id: 'a', name: 'Club A', role: 'manager' }] }, list_documents: { rows: [] } }
  const bytes = new TextEncoder().encode('%PDF-1.4 placeholder document for tests\n')
  const file = new File([bytes], 'guide.pdf', { type: 'application/pdf' })

  function fillForm(chosen: File | null) {
    if (chosen) fireEvent.change(screen.getByLabelText('Document file'), { target: { files: [chosen] } })
    fireEvent.change(screen.getByLabelText('Document title'), { target: { value: 'Club rules' } })
    fireEvent.change(screen.getByLabelText('Document source'), { target: { value: 'Club committee' } })
    fireEvent.change(screen.getByLabelText('Effective date'), { target: { value: '2026-03-01' } })
  }

  it('shows the add form to managers only', async () => {
    render(<DocumentLibrary app={appWith(managerClubs)} />)
    expect(await screen.findByLabelText('Document title')).toBeTruthy()
  })

  it('registers the document with its size and fingerprint, then uploads the bytes through the worker', async () => {
    const app = appWith({ ...managerClubs, register_document: { rows: [] } }) as unknown as { actions: { call: ReturnType<typeof vi.fn> }; worker: { fetch: ReturnType<typeof vi.fn> } }
    app.worker.fetch.mockResolvedValue(new Response(JSON.stringify({ status: 'stored' }), { status: 201 }))
    app.actions.call.mockImplementation(async (name: string) => (name === 'register_document' ? { changes: 1 } : managerClubs[name as keyof typeof managerClubs] ?? { rows: [] }))
    render(<DocumentLibrary app={app as never} />)
    await screen.findByLabelText('Document title')
    fillForm(file)
    fireEvent.click(screen.getByRole('button', { name: 'Add document' }))

    expect(await screen.findByText('Document added and file uploaded.')).toBeTruthy()
    const registration = app.actions.call.mock.calls.find((call) => call[0] === 'register_document')![1] as Record<string, unknown>
    expect(registration).toMatchObject({ org_id: 'a', scope_type: 'club', scope_id: 'a', visibility: 'member', content_type: 'application/pdf', byte_size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') })
    expect(app.worker.fetch).toHaveBeenCalledWith(expect.stringMatching(/^\/documents\/[0-9a-f-]+\/upload\?org=a$/), expect.objectContaining({ method: 'POST', headers: { 'Content-Type': 'application/pdf' } }))
  })

  it('does not register a document a second time when its file upload fails', async () => {
    const app = appWith({ ...managerClubs, register_document: { changes: 1 } }) as unknown as { actions: { call: ReturnType<typeof vi.fn> }; worker: { fetch: ReturnType<typeof vi.fn> } }
    app.worker.fetch.mockRejectedValue(new Error('offline'))
    render(<DocumentLibrary app={app as never} />)
    await screen.findByLabelText('Document title')
    fillForm(file)
    fireEvent.click(screen.getByRole('button', { name: 'Add document' }))
    expect(await screen.findByText('The document was added, but its file was not uploaded. Use Upload file on the document to finish.')).toBeTruthy()
    expect(app.actions.call.mock.calls.filter((call) => call[0] === 'register_document')).toHaveLength(1)
    expect((screen.getByLabelText('Document title') as HTMLInputElement).value).toBe('')
  })

  it('refuses an unsupported file type before anything is registered', async () => {
    const app = appWith(managerClubs) as unknown as { actions: { call: ReturnType<typeof vi.fn> } }
    render(<DocumentLibrary app={app as never} />)
    await screen.findByLabelText('Document title')
    fillForm(new File(['notes'], 'notes.txt', { type: 'text/plain' }))
    fireEvent.click(screen.getByRole('button', { name: 'Add document' }))
    expect(await screen.findByText('Choose a PDF, PNG, JPEG or WebP file.')).toBeTruthy()
    expect(app.actions.call.mock.calls.some((call) => call[0] === 'register_document')).toBe(false)
  })

  it('keeps a registered document and offers an upload when its file is refused', async () => {
    const registered = { ...base, id: 'd9', title: 'Club rules', scope_type: 'club', scope_id: 'a', status: 'registered' }
    const app = appWith({ ...managerClubs, list_documents: { rows: [registered] } }) as unknown as { worker: { fetch: ReturnType<typeof vi.fn> } }
    app.worker.fetch.mockResolvedValue(new Response('mismatch', { status: 422 }))
    render(<DocumentLibrary app={app as never} />)
    const control = await screen.findByLabelText('Upload file for Club rules')
    fireEvent.change(control, { target: { files: [file] } })
    expect(await screen.findByText(uploadMessage(422))).toBeTruthy()
    expect(app.worker.fetch).toHaveBeenCalledWith('/documents/d9/upload?org=a', expect.objectContaining({ method: 'POST' }))
  })
})

describe('document file helpers', () => {
  it('accepts only the four registered types within the size limit', () => {
    expect(documentFileProblem({ type: 'application/pdf', size: 1 })).toBeNull()
    expect(documentFileProblem({ type: 'text/plain', size: 1 })).toBe('Choose a PDF, PNG, JPEG or WebP file.')
    expect(documentFileProblem({ type: 'image/png', size: 0 })).toBe('The file is empty.')
    expect(documentFileProblem({ type: 'image/png', size: 10 * 1024 * 1024 + 1 })).toBe('The file is larger than 10 MB.')
  })

  it('reads the saved filename and maps refusals to plain words', () => {
    expect(filenameFrom('attachment; filename="Parent guidance"')).toBe('Parent guidance')
    expect(filenameFrom(null)).toBeNull()
    expect(downloadMessage(503)).toBe('This file is not available yet. Ask a manager to upload it.')
    expect(uploadMessage(415)).toBe('This file type does not match the registered document.')
  })
})

describe('document list truncation', () => {
  const member = { list_my_clubs: { rows: [{ id: 'a', name: 'Club A', role: 'player' }] } }

  it('says when the library reaches the load limit, so a member knows documents may be missing', async () => {
    const rows = Array.from({ length: DOCUMENT_LIMIT }, (_, index) => ({ ...base, id: `d${index}`, title: `Guide ${index}`, status: 'stored' }))
    render(<DocumentLibrary app={appWith({ ...member, list_documents: { rows } })} />)
    expect(await screen.findByText(`Only the first ${DOCUMENT_LIMIT} documents are loaded. Some documents may not be shown.`)).toBeTruthy()
  })

  it('shows no limit notice when the library is below the load limit', async () => {
    render(<DocumentLibrary app={appWith({ ...member, list_documents: { rows: [{ ...base, id: 'd1', title: 'Parent guidance', status: 'stored' }] } })} />)
    expect(await screen.findByText('Parent guidance')).toBeTruthy()
    expect(screen.queryByText(/Only the first/)).toBeNull()
  })
})

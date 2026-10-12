import { useEffect, useMemo, useState } from 'react'
import type { ProAppStore } from '@proappstore/sdk'
import { applicabilityLabel, CATEGORIES, emptyNames, filterDocuments, namesFrom, seasonOptions, teamOptions, type Document, type DocumentFilters, type NamedRow, type Names } from './documentFilters'
import { DOCUMENT_ACCEPT, documentFileProblem, downloadMessage, filenameFrom, sha256Of, uploadMessage } from './documentFile'
import { outcomeOf } from './auditTrail'

type Club = { id: string; name: string; role: string }

export const visibilityLabel = (visibility: string) => ({
  public: 'Anyone signed in',
  member: 'Club members',
  team: 'Team members',
  manager: 'Managers and convenors',
  admin: 'Administrators only',
} as Record<string, string>)[visibility] ?? visibility

const MANAGER_ROLES = ['admin', 'convenor', 'manager']
const categoryLabel = (category: string) => category.charAt(0).toUpperCase() + category.slice(1)
const noFilters: DocumentFilters = { seasonId: '', teamId: '' }
const emptyForm = { title: '', description: '', source: '', effective: '', category: 'guidance', visibility: 'member' }

export default function DocumentLibrary({ app }: { app: ProAppStore }) {
  const [clubs, setClubs] = useState<Club[]>([])
  const [clubId, setClubId] = useState('')
  const [category, setCategory] = useState('')
  const [filters, setFilters] = useState<DocumentFilters>(noFilters)
  const [documents, setDocuments] = useState<Document[]>([])
  const [names, setNames] = useState<Names>(emptyNames)
  const [loading, setLoading] = useState(true)
  const [documentsLoading, setDocumentsLoading] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const [downloadingId, setDownloadingId] = useState('')
  const [reloadKey, setReloadKey] = useState(0)
  const [form, setForm] = useState(emptyForm)
  const [file, setFile] = useState<File | null>(null)

  const role = clubs.find((club) => club.id === clubId)?.role ?? ''
  const canManage = MANAGER_ROLES.includes(role)
  const visibilityChoices = role === 'admin' ? ['member', 'public', 'manager', 'admin'] : ['member', 'public', 'manager']

  useEffect(() => {
    let active = true
    app.actions.call<{ rows: Club[] }>('list_my_clubs', {})
      .then((result) => { if (active) { const rows = result.rows ?? []; setClubs(rows); setClubId(rows[0]?.id ?? '') } })
      .catch(() => { if (active) setError('Your clubs could not be loaded.') })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [app])

  // Season and team names are manager-only lookups; members fall back to numbered labels.
  useEffect(() => {
    setFilters(noFilters)
    setNotice('')
    if (!clubId) { setNames(emptyNames()); return }
    let active = true
    Promise.all([
      app.actions.call<{ rows: NamedRow[] }>('list_club_seasons', { org_id: clubId, limit: 100 }).then((result) => result.rows ?? []).catch(() => [] as NamedRow[]),
      app.actions.call<{ rows: NamedRow[] }>('list_club_teams', { org_id: clubId, limit: 100 }).then((result) => result.rows ?? []).catch(() => [] as NamedRow[]),
    ]).then(([seasons, teams]) => { if (active) setNames(namesFrom(seasons, teams)) })
    return () => { active = false }
  }, [app, clubId])

  useEffect(() => {
    if (!clubId) { setDocuments([]); return }
    let active = true
    setDocumentsLoading(true)
    setError('')
    app.actions.call<{ rows: Document[] }>('list_documents', category ? { org_id: clubId, category, limit: 100 } : { org_id: clubId, limit: 100 })
      .then((result) => { if (active) setDocuments(result.rows ?? []) })
      .catch(() => { if (active) setError('Documents could not be loaded for this club.') })
      .finally(() => { if (active) setDocumentsLoading(false) })
    return () => { active = false }
  }, [app, clubId, category, reloadKey])

  const seasons = useMemo(() => seasonOptions(documents, names), [documents, names])
  const teams = useMemo(() => teamOptions(documents, names), [documents, names])
  const visible = useMemo(() => filterDocuments(documents, filters), [documents, filters])
  const filtered = Boolean(category || filters.seasonId || filters.teamId)

  async function uploadFile(documentId: string, chosen: File): Promise<number> {
    const response = await app.worker.fetch(`/documents/${encodeURIComponent(documentId)}/upload?org=${encodeURIComponent(clubId)}`, {
      method: 'POST',
      headers: { 'Content-Type': chosen.type },
      body: chosen,
    })
    return response.status
  }

  async function addDocument(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!file) { setNotice('Choose a file to upload.'); return }
    const problem = documentFileProblem(file)
    if (problem) { setNotice(problem); return }
    setBusy(true); setNotice('')
    try {
      const sha256 = await sha256Of(await file.arrayBuffer())
      const id = crypto.randomUUID()
      const registered = await app.actions.call('register_document', {
        id, org_id: clubId, scope_type: 'club', scope_id: clubId, team_id: null,
        title: form.title.trim(), description: form.description.trim() || null, category: form.category, visibility: form.visibility,
        source_attribution: form.source.trim(), effective_on: form.effective, revision: null, expires_on: null,
        content_type: file.type, byte_size: file.size, sha256,
      })
      if (outcomeOf(registered) === 'refused') { setNotice('The document could not be added. Check the details and try again.'); return }
      const status = await uploadFile(id, file)
      setNotice(status === 201 ? 'Document added and file uploaded.' : `Document added, but ${uploadMessage(status)}`)
      setForm(emptyForm); setFile(null)
      setReloadKey((key) => key + 1)
    } catch {
      setNotice('The document could not be added. Try again.')
    } finally { setBusy(false) }
  }

  async function uploadExisting(item: Document, chosen: File | undefined) {
    if (!chosen) return
    const problem = documentFileProblem(chosen)
    if (problem) { setNotice(problem); return }
    setBusy(true); setNotice('')
    try {
      const status = await uploadFile(item.id, chosen)
      setNotice(status === 201 ? 'File uploaded.' : uploadMessage(status))
      setReloadKey((key) => key + 1)
    } catch {
      setNotice('The file could not be uploaded. Try again with the same file.')
    } finally { setBusy(false) }
  }

  async function download(item: Document) {
    setDownloadingId(item.id); setNotice('')
    try {
      const response = await app.worker.fetch(`/documents/${encodeURIComponent(item.id)}/download?org=${encodeURIComponent(clubId)}`)
      if (!response.ok) { setNotice(downloadMessage(response.status)); return }
      const url = URL.createObjectURL(await response.blob())
      const link = globalThis.document.createElement('a')
      link.href = url
      link.download = filenameFrom(response.headers.get('content-disposition')) ?? item.title
      globalThis.document.body.appendChild(link)
      link.click()
      link.remove()
      setTimeout(() => URL.revokeObjectURL(url), 0)
    } catch {
      setNotice('The file could not be downloaded. Try again.')
    } finally { setDownloadingId('') }
  }

  return <main className="mx-auto w-full max-w-5xl px-4 py-8 sm:px-6">
    <h1 className="display-font text-3xl font-bold text-[var(--ink)]">Documents</h1>
    <p className="mt-2 text-sm text-[var(--muted)]">Club guidance and documents. You see only the documents your role and team allow. Contact details are never included.</p>
    {error && <p className="mt-5 rounded-xl bg-[var(--danger)]/10 p-4 text-sm text-[var(--danger)]" role="alert">{error}</p>}
    {notice && <p className="mt-5 rounded-xl bg-[var(--paper-deep)] p-4 text-sm text-[var(--ink)]" role="status">{notice}</p>}
    {loading && <p className="mt-5 text-sm text-[var(--muted)]" role="status">Loading…</p>}
    {!loading && clubs.length === 0 && <p className="mt-5 rounded-2xl border border-dashed border-[var(--line-strong)] p-6 text-sm text-[var(--muted)]">You are not a member of a club yet.</p>}
    {clubs.length > 1 && <label className="mt-6 block max-w-xl text-sm font-semibold text-[var(--ink)]">Club<select className="mt-1 min-h-11 w-full rounded-xl border border-[var(--line)] bg-[var(--surface)] px-3" value={clubId} onChange={(event) => setClubId(event.target.value)}>{clubs.map((club) => <option key={club.id} value={club.id}>{club.name}</option>)}</select></label>}

    {clubId && canManage && <form onSubmit={(event) => void addDocument(event)} className="mt-6 rounded-2xl border border-[var(--line)] bg-[var(--surface)] p-5">
      <h2 className="text-lg font-bold text-[var(--ink)]">Add a document</h2>
      <p className="mt-1 text-sm text-[var(--muted)]">Upload an approved club file. Choose who can see it; members can download it only if their role allows.</p>
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <label className="text-sm font-semibold text-[var(--ink)]">File<input aria-label="Document file" type="file" accept={DOCUMENT_ACCEPT} className="mt-1 block w-full text-sm" onChange={(event) => setFile(event.target.files?.[0] ?? null)} /></label>
        <label className="text-sm font-semibold text-[var(--ink)]">Title<input aria-label="Document title" required maxLength={120} value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })} className="mt-1 min-h-11 w-full rounded-xl border border-[var(--line)] bg-[var(--surface)] px-3" /></label>
        <label className="text-sm font-semibold text-[var(--ink)]">Category<select aria-label="Document category" value={form.category} onChange={(event) => setForm({ ...form, category: event.target.value })} className="mt-1 min-h-11 w-full rounded-xl border border-[var(--line)] bg-[var(--surface)] px-3">{CATEGORIES.map((item) => <option key={item} value={item}>{categoryLabel(item)}</option>)}</select></label>
        <label className="text-sm font-semibold text-[var(--ink)]">Who can see it<select aria-label="Document visibility" value={form.visibility} onChange={(event) => setForm({ ...form, visibility: event.target.value })} className="mt-1 min-h-11 w-full rounded-xl border border-[var(--line)] bg-[var(--surface)] px-3">{visibilityChoices.map((item) => <option key={item} value={item}>{visibilityLabel(item)}</option>)}</select></label>
        <label className="text-sm font-semibold text-[var(--ink)]">Source<input aria-label="Document source" required maxLength={120} value={form.source} onChange={(event) => setForm({ ...form, source: event.target.value })} placeholder="For example, Club committee" className="mt-1 min-h-11 w-full rounded-xl border border-[var(--line)] bg-[var(--surface)] px-3" /></label>
        <label className="text-sm font-semibold text-[var(--ink)]">Effective date<input aria-label="Effective date" type="date" required value={form.effective} onChange={(event) => setForm({ ...form, effective: event.target.value })} className="mt-1 min-h-11 w-full rounded-xl border border-[var(--line)] bg-[var(--surface)] px-3" /></label>
        <label className="text-sm font-semibold text-[var(--ink)] sm:col-span-2">Description (optional)<input aria-label="Document description" maxLength={300} value={form.description} onChange={(event) => setForm({ ...form, description: event.target.value })} className="mt-1 min-h-11 w-full rounded-xl border border-[var(--line)] bg-[var(--surface)] px-3" /></label>
      </div>
      <button type="submit" disabled={busy} className="mt-4 min-h-11 rounded-xl bg-[var(--accent)] px-5 font-semibold text-white disabled:opacity-50">{busy ? 'Adding…' : 'Add document'}</button>
    </form>}

    {clubId && <fieldset className="mt-6 grid gap-3 sm:grid-cols-3">
      <legend className="sr-only">Filter documents</legend>
      <label className="text-sm font-semibold text-[var(--ink)]">Category<select className="mt-1 min-h-11 w-full rounded-xl border border-[var(--line)] bg-[var(--surface)] px-3" value={category} onChange={(event) => setCategory(event.target.value)}><option value="">All categories</option>{CATEGORIES.map((item) => <option key={item} value={item}>{categoryLabel(item)}</option>)}</select></label>
      {seasons.length > 0 && <label className="text-sm font-semibold text-[var(--ink)]">Season<select className="mt-1 min-h-11 w-full rounded-xl border border-[var(--line)] bg-[var(--surface)] px-3" value={filters.seasonId} onChange={(event) => setFilters({ ...filters, seasonId: event.target.value })}><option value="">All seasons</option>{seasons.map((season) => <option key={season.id} value={season.id}>{season.name}</option>)}</select></label>}
      {teams.length > 0 && <label className="text-sm font-semibold text-[var(--ink)]">Team<select className="mt-1 min-h-11 w-full rounded-xl border border-[var(--line)] bg-[var(--surface)] px-3" value={filters.teamId} onChange={(event) => setFilters({ ...filters, teamId: event.target.value })}><option value="">All teams</option>{teams.map((team) => <option key={team.id} value={team.id}>{team.name}</option>)}</select></label>}
    </fieldset>}
    {documentsLoading && <p className="mt-5 text-sm text-[var(--muted)]" role="status">Loading documents…</p>}
    {!documentsLoading && clubs.length > 0 && visible.length === 0 && !error && <p className="mt-6 rounded-2xl border border-dashed border-[var(--line-strong)] p-6 text-sm text-[var(--muted)]">{filtered ? 'No documents match these filters.' : 'No documents are available to you in this club.'}</p>}
    <ul className="mt-6 grid gap-3">{visible.map((item) => <li key={item.id} className="rounded-2xl border border-[var(--line)] bg-[var(--surface)] p-4 shadow-sm">
      <p className="text-sm font-semibold text-[var(--accent-deep)]">{categoryLabel(item.category)} · {visibilityLabel(item.visibility)}</p>
      <h2 className="mt-1 text-lg font-bold text-[var(--ink)]">{item.title}</h2>
      <p className="mt-1 text-sm font-semibold text-[var(--ink)]">{applicabilityLabel(item, names)}</p>
      {item.description && <p className="mt-1 text-sm text-[var(--ink)]">{item.description}</p>}
      <p className="mt-2 text-xs text-[var(--muted)]">Source: {item.source_attribution} · Effective {item.effective_on}{item.revision ? ` · Revision ${item.revision}` : ''}{item.expires_on ? ` · Expires ${item.expires_on}` : ''}</p>
      <p className="mt-1 text-xs font-semibold text-[var(--muted)]">{item.status === 'stored' ? 'File available' : 'File not yet uploaded'}</p>
      {item.status === 'stored' && <button type="button" disabled={downloadingId === item.id} onClick={() => void download(item)} className="mt-3 min-h-11 rounded-xl border border-[var(--line)] bg-[var(--surface)] px-4 text-sm font-semibold text-[var(--ink)] disabled:opacity-60">{downloadingId === item.id ? 'Preparing…' : 'Download'}</button>}
      {item.status === 'registered' && canManage && <label className="mt-3 block text-sm font-semibold text-[var(--ink)]">Upload file<input aria-label={`Upload file for ${item.title}`} type="file" accept={DOCUMENT_ACCEPT} disabled={busy} className="mt-1 block w-full text-sm" onChange={(event) => void uploadExisting(item, event.target.files?.[0])} /></label>}
    </li>)}</ul>
  </main>
}

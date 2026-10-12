import { useEffect, useMemo, useState } from 'react'
import type { ProAppStore } from '@proappstore/sdk'
import { applicabilityLabel, CATEGORIES, emptyNames, filterDocuments, namesFrom, seasonOptions, teamOptions, type Document, type DocumentFilters, type NamedRow, type Names } from './documentFilters'

type Club = { id: string; name: string; role: string }

export const visibilityLabel = (visibility: string) => ({
  public: 'Anyone signed in',
  member: 'Club members',
  team: 'Team members',
  manager: 'Managers and convenors',
  admin: 'Administrators only',
} as Record<string, string>)[visibility] ?? visibility

const categoryLabel = (category: string) => category.charAt(0).toUpperCase() + category.slice(1)
const noFilters: DocumentFilters = { seasonId: '', teamId: '' }

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
  }, [app, clubId, category])

  const seasons = useMemo(() => seasonOptions(documents, names), [documents, names])
  const teams = useMemo(() => teamOptions(documents, names), [documents, names])
  const visible = useMemo(() => filterDocuments(documents, filters), [documents, filters])
  const filtered = Boolean(category || filters.seasonId || filters.teamId)

  return <main className="mx-auto w-full max-w-5xl px-4 py-8 sm:px-6">
    <h1 className="display-font text-3xl font-bold text-[var(--ink)]">Documents</h1>
    <p className="mt-2 text-sm text-[var(--muted)]">Club guidance and documents. You see only the documents your role and team allow. Contact details are never included.</p>
    <p className="mt-3 rounded-xl bg-[var(--paper-deep)] p-4 text-sm text-[var(--ink)]">File downloads and uploads are not available yet and will be added in a later update. Document records, who may see them and the access checks are live.</p>
    {error && <p className="mt-5 rounded-xl bg-[var(--danger)]/10 p-4 text-sm text-[var(--danger)]" role="alert">{error}</p>}
    {loading && <p className="mt-5 text-sm text-[var(--muted)]" role="status">Loading…</p>}
    {!loading && clubs.length === 0 && <p className="mt-5 rounded-2xl border border-dashed border-[var(--line-strong)] p-6 text-sm text-[var(--muted)]">You are not a member of a club yet.</p>}
    {clubs.length > 1 && <label className="mt-6 block max-w-xl text-sm font-semibold text-[var(--ink)]">Club<select className="mt-1 min-h-11 w-full rounded-xl border border-[var(--line)] bg-[var(--surface)] px-3" value={clubId} onChange={(event) => setClubId(event.target.value)}>{clubs.map((club) => <option key={club.id} value={club.id}>{club.name}</option>)}</select></label>}
    {clubId && <fieldset className="mt-6 grid gap-3 sm:grid-cols-3">
      <legend className="sr-only">Filter documents</legend>
      <label className="text-sm font-semibold text-[var(--ink)]">Category<select className="mt-1 min-h-11 w-full rounded-xl border border-[var(--line)] bg-[var(--surface)] px-3" value={category} onChange={(event) => setCategory(event.target.value)}><option value="">All categories</option>{CATEGORIES.map((item) => <option key={item} value={item}>{categoryLabel(item)}</option>)}</select></label>
      {seasons.length > 0 && <label className="text-sm font-semibold text-[var(--ink)]">Season<select className="mt-1 min-h-11 w-full rounded-xl border border-[var(--line)] bg-[var(--surface)] px-3" value={filters.seasonId} onChange={(event) => setFilters({ ...filters, seasonId: event.target.value })}><option value="">All seasons</option>{seasons.map((season) => <option key={season.id} value={season.id}>{season.name}</option>)}</select></label>}
      {teams.length > 0 && <label className="text-sm font-semibold text-[var(--ink)]">Team<select className="mt-1 min-h-11 w-full rounded-xl border border-[var(--line)] bg-[var(--surface)] px-3" value={filters.teamId} onChange={(event) => setFilters({ ...filters, teamId: event.target.value })}><option value="">All teams</option>{teams.map((team) => <option key={team.id} value={team.id}>{team.name}</option>)}</select></label>}
    </fieldset>}
    {documentsLoading && <p className="mt-5 text-sm text-[var(--muted)]" role="status">Loading documents…</p>}
    {!documentsLoading && clubs.length > 0 && visible.length === 0 && !error && <p className="mt-6 rounded-2xl border border-dashed border-[var(--line-strong)] p-6 text-sm text-[var(--muted)]">{filtered ? 'No documents match these filters.' : 'No documents are available to you in this club.'}</p>}
    <ul className="mt-6 grid gap-3">{visible.map((document) => <li key={document.id} className="rounded-2xl border border-[var(--line)] bg-[var(--surface)] p-4 shadow-sm">
      <p className="text-sm font-semibold text-[var(--accent-deep)]">{categoryLabel(document.category)} · {visibilityLabel(document.visibility)}</p>
      <h2 className="mt-1 text-lg font-bold text-[var(--ink)]">{document.title}</h2>
      <p className="mt-1 text-sm font-semibold text-[var(--ink)]">{applicabilityLabel(document, names)}</p>
      {document.description && <p className="mt-1 text-sm text-[var(--ink)]">{document.description}</p>}
      <p className="mt-2 text-xs text-[var(--muted)]">Source: {document.source_attribution} · Effective {document.effective_on}{document.revision ? ` · Revision ${document.revision}` : ''}{document.expires_on ? ` · Expires ${document.expires_on}` : ''}</p>
      <p className="mt-1 text-xs font-semibold text-[var(--muted)]">{document.status === 'stored' ? 'File stored; download not yet available' : 'File not yet available'}</p>
      {document.status === 'stored' && <button type="button" disabled title="Downloads are not available yet" className="mt-3 min-h-11 rounded-xl border border-[var(--line)] px-4 text-sm font-semibold text-[var(--muted)] disabled:opacity-60">Download unavailable</button>}
    </li>)}</ul>
  </main>
}

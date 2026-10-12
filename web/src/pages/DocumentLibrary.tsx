import { useEffect, useState } from 'react'
import type { ProAppStore } from '@proappstore/sdk'

type Club = { id: string; name: string; role: string }
type Document = { id: string; title: string; description: string | null; category: string; visibility: string; source_attribution: string; effective_on: string; revision: string | null; expires_on: string | null; status: string; byte_size: number | null }

export const visibilityLabel = (visibility: string) => ({
  public: 'Anyone signed in',
  member: 'Club members',
  team: 'Team members',
  manager: 'Managers and convenors',
  admin: 'Administrators only',
} as Record<string, string>)[visibility] ?? visibility

const categoryLabel = (category: string) => category.charAt(0).toUpperCase() + category.slice(1)

export default function DocumentLibrary({ app }: { app: ProAppStore }) {
  const [clubs, setClubs] = useState<Club[]>([])
  const [clubId, setClubId] = useState('')
  const [documents, setDocuments] = useState<Document[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const canManage = ['admin', 'convenor', 'manager'].includes(clubs.find((club) => club.id === clubId)?.role ?? '')

  useEffect(() => {
    let active = true
    app.actions.call<{ rows: Club[] }>('list_my_clubs', {})
      .then((result) => { if (active) { const rows = result.rows ?? []; setClubs(rows); setClubId(rows[0]?.id ?? '') } })
      .catch(() => { if (active) setError('Your clubs could not be loaded.') })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [app])

  useEffect(() => {
    if (!clubId) { setDocuments([]); return }
    let active = true
    app.actions.call<{ rows: Document[] }>('list_documents', { org_id: clubId })
      .then((result) => { if (active) setDocuments(result.rows ?? []) })
      .catch(() => { if (active) setError('Documents could not be loaded for this club.') })
    return () => { active = false }
  }, [app, clubId])

  async function uploadFile(document: Document, file?: File) {
    if (!file || !clubId) return
    setBusy(true); setMessage(''); setError('')
    try {
      const response = await app.worker.fetch(`/documents/${document.id}/upload?org=${encodeURIComponent(clubId)}`, { method: 'POST', headers: { 'Content-Type': file.type }, body: file })
      if (!response.ok) { setError('The file could not be stored. Check that it matches the registered type, size and hash.'); return }
      setMessage(`${document.title} is now stored.`)
      const result = await app.actions.call<{ rows: Document[] }>('list_documents', { org_id: clubId })
      setDocuments(result.rows ?? [])
    } catch { setError('The file could not be uploaded. Please try again.') }
    finally { setBusy(false) }
  }

  return <main className="mx-auto w-full max-w-5xl px-4 py-8 sm:px-6">
    <h1 className="display-font text-3xl font-bold text-[var(--ink)]">Documents</h1>
    <p className="mt-2 text-sm text-[var(--muted)]">Club guidance and documents. You see only the documents your role and team allow. Contact details are never included.</p>
    {error && <p className="mt-5 rounded-xl bg-[var(--danger)]/10 p-4 text-sm text-[var(--danger)]" role="alert">{error}</p>}
    {message && <p className="mt-5 rounded-xl bg-[var(--mint-soft)] p-4 text-sm text-[var(--mint-deep)]" role="status">{message}</p>}
    {loading && <p className="mt-5 text-sm text-[var(--muted)]" role="status">Loading…</p>}
    {!loading && clubs.length === 0 && <p className="mt-5 rounded-2xl border border-dashed border-[var(--line-strong)] p-6 text-sm text-[var(--muted)]">You are not a member of a club yet.</p>}
    {clubs.length > 1 && <label className="mt-6 block max-w-xl text-sm font-semibold text-[var(--ink)]">Club<select className="mt-1 min-h-11 w-full rounded-xl border border-[var(--line)] bg-[var(--surface)] px-3" value={clubId} onChange={(event) => setClubId(event.target.value)}>{clubs.map((club) => <option key={club.id} value={club.id}>{club.name}</option>)}</select></label>}
    {clubs.length > 0 && documents.length === 0 && !error && <p className="mt-6 rounded-2xl border border-dashed border-[var(--line-strong)] p-6 text-sm text-[var(--muted)]">No documents are available to you in this club.</p>}
    <ul className="mt-6 grid gap-3">{documents.map((document) => <li key={document.id} className="rounded-2xl border border-[var(--line)] bg-[var(--surface)] p-4 shadow-sm">
      <p className="text-sm font-semibold text-[var(--accent-deep)]">{categoryLabel(document.category)} · {visibilityLabel(document.visibility)}</p>
      <h2 className="mt-1 text-lg font-bold text-[var(--ink)]">{document.title}</h2>
      {document.description && <p className="mt-1 text-sm text-[var(--ink)]">{document.description}</p>}
      <p className="mt-2 text-xs text-[var(--muted)]">Source: {document.source_attribution} · Effective {document.effective_on}{document.revision ? ` · Revision ${document.revision}` : ''}{document.expires_on ? ` · Expires ${document.expires_on}` : ''}</p>
      {document.status === 'stored' && <a href={`/.pas/worker/documents/${document.id}/download?org=${encodeURIComponent(clubId)}`} className="mt-3 inline-flex min-h-11 items-center font-semibold text-[var(--accent)] underline">Download file</a>}
      {document.status !== 'stored' && <p className="mt-1 text-xs font-semibold text-[var(--muted)]">File not yet uploaded</p>}
      {document.status === 'registered' && canManage && <label className="mt-2 block text-sm font-semibold text-[var(--ink)]">Upload file<input type="file" accept="application/pdf,image/png,image/jpeg,image/webp" disabled={busy} className="mt-1 block w-full text-sm" onChange={(event) => void uploadFile(document, event.target.files?.[0])} /></label>}
    </li>)}</ul>
  </main>
}

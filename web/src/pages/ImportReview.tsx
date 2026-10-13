import { useCallback, useEffect, useState } from 'react'
import type { ProAppStore } from '@proappstore/sdk'
import { fixtureStartLabel } from '../fixtureTime'
import { outcomeOf, recordAudit } from './auditTrail'
import { approvalLabel, awaitingReview, fingerprint, issueSeverityLabel, latestRun, managerClubs, provenanceRows, reportDate, type Club, type ImportRun, type ManagedFixture, type RunIssue } from './importReviewLogic'

const kindLabel = (kind: ImportRun['kind']) => (kind === 'fixtures' ? 'Fixture book' : 'Team roster')
const timeStatusLabel = (status: string | null) => ({ confirmed: 'Confirmed time', estimated: 'Estimated time', tbc: 'Start time TBC' } as Record<string, string>)[status ?? ''] ?? 'Time not recorded'
type Notice = { tone: 'success' | 'error'; text: string }

export default function ImportReview({ app }: { app: ProAppStore }) {
  const [clubs, setClubs] = useState<Club[] | null>(null)
  const [clubId, setClubId] = useState('')
  const [runs, setRuns] = useState<ImportRun[]>([])
  const [fixtures, setFixtures] = useState<ManagedFixture[]>([])
  const [loading, setLoading] = useState(true)
  const [runsLoading, setRunsLoading] = useState(false)
  const [fixturesLoading, setFixturesLoading] = useState(true)
  const [fixturesReady, setFixturesReady] = useState(false)
  const [reviewingId, setReviewingId] = useState('')
  const [notice, setNotice] = useState<Notice | null>(null)
  const [issues, setIssues] = useState<RunIssue[]>([])
  const [issuesError, setIssuesError] = useState('')
  const [error, setError] = useState('')

  const loadFixtures = useCallback(async () => {
    setFixturesLoading(true)
    try {
      const result = await app.actions.call<{ rows: ManagedFixture[] }>('list_managed_fixtures', { limit: 100 })
      setFixtures(result.rows ?? [])
      setFixturesReady(true)
    } catch { setError('Imported fixtures could not be loaded.') }
    finally { setFixturesLoading(false) }
  }, [app])

  useEffect(() => {
    let active = true
    app.actions.call<{ rows: Club[] }>('list_my_clubs', {})
      .then((result) => {
        if (!active) return
        const manager = managerClubs(result.rows ?? [])
        setClubs(manager)
        setClubId(manager[0]?.id ?? '')
      })
      .catch(() => { if (active) setError('Your clubs could not be loaded.') })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [app])

  useEffect(() => { void loadFixtures() }, [loadFixtures])

  useEffect(() => {
    if (!clubId) { setRuns([]); return }
    let active = true
    setRunsLoading(true)
    app.actions.call<{ rows: ImportRun[] }>('list_import_reports', { org_id: clubId, limit: 50 })
      .then((result) => { if (active) setRuns(result.rows ?? []) })
      .catch(() => { if (active) setError('Import reports could not be loaded for this club.') })
      .finally(() => { if (active) setRunsLoading(false) })
    return () => { active = false }
  }, [app, clubId])

  // The approval is one fixture at a time. A refusal is audited too, as the other manager writes are.
  async function approve(fixture: ManagedFixture) {
    setReviewingId(fixture.id); setNotice(null)
    const target = { orgId: fixture.org_id, action: 'approve_fixture_review', targetType: 'fixture', targetId: fixture.id }
    try {
      const result = await app.actions.call('approve_fixture_review', { fixture_id: fixture.id })
      const outcome = outcomeOf(result)
      const audited = await recordAudit(app, { ...target, outcome })
      await loadFixtures()
      if (outcome === 'refused') setNotice({ tone: 'error', text: 'This fixture was not approved. It may already be approved, or its import has blocking conflicts.' })
      else setNotice(audited ? { tone: 'success', text: 'Fixture approved. Members can now see it.' } : { tone: 'error', text: 'Fixture approved, but the audit record could not be written. Tell an administrator.' })
    } catch {
      await recordAudit(app, { ...target, outcome: 'refused' })
      setNotice({ tone: 'error', text: 'The approval could not be saved. Try again.' })
    } finally { setReviewingId('') }
  }

  const fixtureRunId = latestRun(runs, 'fixtures')?.id ?? ''

  // The row issues the import check stored on this fixture book's run.
  useEffect(() => {
    if (!clubId || !fixtureRunId) { setIssues([]); return }
    let active = true
    app.actions.call<{ rows: RunIssue[] }>('list_import_run_issues', { org_id: clubId, import_run_id: fixtureRunId, limit: 100 })
      .then((result) => { if (active) { setIssues(result.rows ?? []); setIssuesError('') } })
      .catch(() => { if (active) setIssuesError('Row issues could not be loaded for this import.') })
    return () => { active = false }
  }, [app, clubId, fixtureRunId])

  const fixtureRun = latestRun(runs, 'fixtures')
  const rosterRun = latestRun(runs, 'roster')
  const provenance = fixtureRun ? provenanceRows(fixtures, clubId, fixtureRun.id) : []
  const waiting = provenance.filter(awaitingReview).length
  // Empty messages only after a successful load; a failed load is reported by the error alert above.
  const idle = fixturesReady && !fixturesLoading && !runsLoading

  return <main className="mx-auto w-full max-w-5xl px-4 py-8 sm:px-6">
    <h1 className="display-font text-3xl font-bold text-[var(--ink)]">Import review</h1>
    <p className="mt-2 text-sm text-[var(--muted)]">The latest fixture and roster imports for your club, with where each fixture came from. For club managers, convenors and admins.</p>
    {loading && <p className="mt-5 text-sm text-[var(--muted)]" role="status">Loading…</p>}
    {error && <p className="mt-5 rounded-xl bg-[var(--danger)]/10 p-4 text-sm text-[var(--danger)]" role="alert">{error}</p>}
    {!loading && clubs && clubs.length === 0 && <p className="mt-5 rounded-xl bg-[var(--danger)]/10 p-4 text-sm text-[var(--danger)]">Import review is for club managers, convenors and admins.</p>}
    {clubs && clubs.length > 1 && <label className="mt-6 block max-w-xl text-sm font-semibold text-[var(--ink)]">Club<select className="mt-1 min-h-11 w-full rounded-xl border border-[var(--line)] bg-[var(--surface)] px-3" value={clubId} onChange={(event) => setClubId(event.target.value)}>{clubs.map((club) => <option key={club.id} value={club.id}>{club.name}</option>)}</select></label>}
    {clubs && clubs.length > 0 && <>
      {runsLoading && <p className="mt-5 text-sm text-[var(--muted)]" role="status">Loading import reports…</p>}
      {!runsLoading && <div className="mt-6 grid gap-4 sm:grid-cols-2">
        {[{ kind: 'fixtures' as const, run: fixtureRun }, { kind: 'roster' as const, run: rosterRun }].map(({ kind, run }) => <section key={kind} className="rounded-2xl border border-[var(--line)] bg-[var(--surface)] p-4 shadow-sm">
          <h2 className="text-lg font-bold text-[var(--ink)]">{kindLabel(kind)}</h2>
          {!run && <p className="mt-2 text-sm text-[var(--muted)]">No {kind === 'fixtures' ? 'fixture book' : 'roster'} import has been recorded for this club.</p>}
          {run && <>
            <p className={`mt-2 text-sm font-semibold ${run.status === 'saved' ? 'text-[var(--mint-deep)]' : 'text-[var(--danger)]'}`}>{run.status === 'saved' ? 'Saved' : 'Rejected'} · {reportDate(run.created_at)}</p>
            <dl className="mt-3 grid grid-cols-2 gap-2 text-sm">
              <div><dt className="text-xs text-[var(--muted)]">Rows received</dt><dd className="font-semibold text-[var(--ink)]">{run.received_count}</dd></div>
              <div><dt className="text-xs text-[var(--muted)]">Rows saved</dt><dd className="font-semibold text-[var(--ink)]">{run.saved_count}</dd></div>
              <div><dt className="text-xs text-[var(--muted)]">Rows rejected</dt><dd className="font-semibold text-[var(--ink)]">{run.rejected_count}</dd></div>
              <div><dt className="text-xs text-[var(--muted)]">Blocking conflicts</dt><dd className="font-semibold text-[var(--ink)]">{run.blocking_count}</dd></div>
              <div><dt className="text-xs text-[var(--muted)]">Warnings</dt><dd className="font-semibold text-[var(--ink)]">{run.warning_count}</dd></div>
              <div><dt className="text-xs text-[var(--muted)]">Warnings accepted</dt><dd className="font-semibold text-[var(--ink)]">{run.acknowledged_count}</dd></div>
            </dl>
            <p className="mt-3 text-xs text-[var(--muted)]">Source file fingerprint: <span className="font-mono">{fingerprint(run.source_sha256)}</span></p>
          </>}
        </section>)}
      </div>}
      <p className="mt-4 rounded-xl bg-[var(--paper-deep)] p-4 text-sm text-[var(--ink)]">Row-by-row warnings and conflicts are not stored with a saved import. They are listed when you check a file on the Import page, which also records each accepted warning.</p>
      <a href="/fixture-import" className="mt-3 inline-flex min-h-11 items-center rounded-xl border border-[var(--line)] bg-[var(--surface)] px-4 font-semibold text-[var(--ink)]">Check a file on the Import page</a>

      <section className="mt-8">
        <h2 className="text-xl font-bold text-[var(--ink)]">Review imported fixtures</h2>
        {idle && fixtureRun && issuesError && <p role="alert" className="mt-3 rounded-xl bg-[var(--danger)]/10 p-4 text-sm text-[var(--danger)]">{issuesError}</p>}
        {idle && fixtureRun && !issuesError && <section className="mt-4">
          <h3 className="text-lg font-bold text-[var(--ink)]">Row issues from this import</h3>
          {issues.length === 0 && <p className="mt-2 text-sm text-[var(--muted)]">No row issues were recorded for this import.</p>}
          {issues.length > 0 && <ul className="mt-2 grid gap-2">{issues.map((issue) => <li key={`${issue.source_row}:${issue.code}`} className="rounded-xl border border-[var(--line)] bg-[var(--surface)] p-3 text-sm">
            <span className="font-semibold text-[var(--ink)]">Source line {issue.source_row} · {issueSeverityLabel(issue.severity)} · {issue.code}</span>
            <span className="block text-[var(--ink)]">{issue.message}</span>
            {issue.remediation && <span className="block text-xs text-[var(--muted)]">{issue.remediation}</span>}
          </li>)}</ul>}
        </section>}
        {fixturesLoading && <p className="mt-2 text-sm text-[var(--muted)]" role="status">Loading fixtures…</p>}
        {idle && !fixtureRun && <p className="mt-2 rounded-2xl border border-dashed border-[var(--line-strong)] p-6 text-sm text-[var(--muted)]">No fixtures have been imported for this club yet.</p>}
        {idle && fixtureRun && provenance.length === 0 && <p className="mt-2 rounded-2xl border border-dashed border-[var(--line-strong)] p-6 text-sm text-[var(--muted)]">The latest import has no fixtures you can manage.</p>}
        {idle && provenance.length > 0 && <>
          <p className="mt-2 text-sm text-[var(--muted)]">{provenance.length} fixtures from the latest fixture book{waiting > 0 ? `, ${waiting} waiting for review` : ''}.</p>
          {waiting > 0
            ? <p className="mt-3 rounded-xl bg-[var(--paper-deep)] p-4 text-sm text-[var(--ink)]">Fixtures with an estimated or TBC start time stay hidden from members until a manager approves them. Other fixtures are visible straight away.</p>
            : <p className="mt-3 text-sm font-semibold text-[var(--mint-deep)]">No fixtures need review.</p>}
          {notice && <p role={notice.tone === 'error' ? 'alert' : 'status'} className={`mt-3 rounded-xl p-4 text-sm ${notice.tone === 'error' ? 'bg-[var(--danger)]/10 text-[var(--danger)]' : 'bg-[var(--paper-deep)] text-[var(--ink)]'}`}>{notice.text}</p>}
          <ul className="mt-4 grid gap-3">{provenance.map((fixture) => {
            const title = `${fixture.home_team_name} vs ${fixture.opponent_name ?? fixture.away_team_name}`
            return <li key={fixture.id} className="rounded-2xl border border-[var(--line)] bg-[var(--surface)] p-4 shadow-sm">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h3 className="font-bold text-[var(--ink)]">{fixture.home_team_name} <span className="font-medium text-[var(--muted)]">vs</span> {fixture.opponent_name ?? fixture.away_team_name}</h3>
                {awaitingReview(fixture) && <span className="rounded-full bg-[var(--danger)]/10 px-2 py-1 text-xs font-semibold text-[var(--danger)]">Needs review</span>}
              </div>
              <p className="mt-1 text-sm text-[var(--muted)]">{fixtureStartLabel(fixture)} · {timeStatusLabel(fixture.time_status)}</p>
              <p className="mt-1 text-sm font-semibold text-[var(--ink)]">{awaitingReview(fixture) ? 'Hidden from members until approved' : approvalLabel(fixture)}</p>
              <p className="mt-2 text-xs text-[var(--muted)]">Source line {fixture.source_row ?? '—'} · Date as imported: {fixture.source_date_raw || '—'} · Start as imported: {fixture.source_time_raw || '—'}{fixture.round_label ? ` · ${fixture.round_label}` : ''}</p>
              {awaitingReview(fixture) && <button type="button" aria-label={`Approve ${title}, source line ${fixture.source_row ?? 'unknown'}`} disabled={reviewingId !== ''} onClick={() => void approve(fixture)} className="mt-3 min-h-11 rounded-xl bg-[var(--accent)] px-4 font-semibold text-white disabled:opacity-50">{reviewingId === fixture.id ? 'Approving…' : 'Approve'}</button>}
            </li>
          })}</ul>
        </>}
      </section>
    </>}
  </main>
}

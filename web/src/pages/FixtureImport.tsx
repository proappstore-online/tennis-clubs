import { useState } from 'react'
import type { ProAppStore } from '@proappstore/sdk'
import { recordAudit } from './auditTrail'
import { mapFixtureRows, normalizeDate, parseCsv, type FixtureOption, type FixtureRow } from './fixtureImportLogic'

type Option = FixtureOption
type RosterRow = { player_name: string; contact: string; team: string; fixture_round: string; fixture_opponent: string; fixture_date: string; issue?: string }
type Issue = { source_row: number; severity: 'blocking' | 'warning'; code: string; field: string; message: string; remediation: string }
type RawRow = Record<string, string>

const issueKey = (issue: Issue) => `${issue.code}:${issue.source_row}`

export default function FixtureImport({ app }: { app: ProAppStore }) {
  const [options, setOptions] = useState<Option[]>([])
  const [fixtures, setFixtures] = useState<FixtureRow[]>([])
  const [rawRows, setRawRows] = useState<RawRow[]>([])
  const [fileDigest, setFileDigest] = useState('')
  const [roster, setRoster] = useState<RosterRow[]>([])
  const [runId, setRunId] = useState('')
  const [issues, setIssues] = useState<Issue[] | null>(null)
  const [acknowledged, setAcknowledged] = useState<string[]>([])
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [authorized, setAuthorized] = useState<boolean | null>(null)

  const blocking = (issues ?? []).filter((issue) => issue.severity === 'blocking')
  const warnings = (issues ?? []).filter((issue) => issue.severity === 'warning')
  const reviewComplete = issues !== null && blocking.length === 0 && warnings.every((issue) => acknowledged.includes(issueKey(issue)))

  async function loadOptions() {
    setBusy(true); setMessage('')
    try {
      const result = await app.actions.call<{ rows: Option[] }>('list_fixture_import_options', {})
      const rows = result.rows ?? []
      setAuthorized(rows.length > 0)
      setOptions(rows)
      if (!rows.some((item) => item.kind === 'team')) setMessage('Your account has no manager, convenor or admin membership for a club.')
    } catch { setAuthorized(false); setMessage('Manager access could not be verified for fixture imports.') }
    finally { setBusy(false) }
  }

  async function readFixtureFile(file?: File) {
    if (!file) return
    const text = await file.text()
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
    setFileDigest(Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join(''))
    const parsed = parseCsv(text)
    setRawRows(parsed)
    setFixtures(mapFixtureRows(parsed, options))
    setRunId(''); setIssues(null); setAcknowledged([])
  }

  async function readRosterFile(file?: File) {
    if (!file) return
    const parsed = parseCsv(await file.text()) as RosterRow[]
    setRoster(parsed.map((row) => {
      const date = normalizeDate(row.fixture_date)
      const relatedFixture = fixtures.find((fixture) => fixture.date === date && fixture.round.trim().toLowerCase() === row.fixture_round.trim().toLowerCase() && (fixture.opponent.trim().toLowerCase() === row.fixture_opponent.trim().toLowerCase() || fixture.team.trim().toLowerCase() === row.fixture_opponent.trim().toLowerCase()))
      const teamExists = options.some((item) => item.kind === 'team' && item.name.toLowerCase() === row.team.trim().toLowerCase())
      const problems = [!row.player_name?.trim() && 'missing player name', !row.team?.trim() && 'missing team', row.team && !teamExists && 'team not found', !date && 'invalid fixture date', !relatedFixture && 'fixture not found in fixture import'].filter(Boolean)
      return { ...row, fixture_date: date ?? row.fixture_date, issue: problems.join(', ') }
    }))
  }

  async function check() {
    if (!fixtures.length) return
    setBusy(true); setMessage('')
    try {
      const rows = rawRows.map((row, index) => ({ source_row: index + 2, date: row.date ?? '', start_time: row.start_time ?? '', arrival_time: row.arrival_time ?? '', time_status: row.time_status ?? '', timezone: row.timezone ?? '', round: row.round ?? '', opponent: row.opponent ?? '', home_away: row.home_away ?? '', venue: row.venue ?? '', team: row.team ?? '', season: row.season ?? '' }))
      const id = crypto.randomUUID()
      const result = await app.actions.call<{ rows: Issue[] }>('validate_fixture_import', { org_id: fixtures[0].org_id, rows: JSON.stringify(rows) })
      setRunId(id); setIssues(result.rows ?? []); setAcknowledged([])
    } catch { setMessage('The import could not be checked. Please try again.') }
    finally { setBusy(false) }
  }

  async function acknowledge(issue: Issue) {
    const orgId = fixtures[0]?.org_id
    if (!orgId || !runId) return
    setBusy(true)
    try {
      await app.actions.call('record_fixture_import_resolution', { id: crypto.randomUUID(), org_id: orgId, import_run_id: runId, code: issue.code, source_row: issue.source_row })
      setAcknowledged((current) => [...current, issueKey(issue)])
    } catch { setMessage(`The warning could not be accepted: ${issue.message}`) }
    finally { setBusy(false) }
  }

  async function recordImport(orgId: string | undefined, kind: 'fixtures' | 'roster', received: number, saved: number, status: 'saved' | 'rejected', id: string, counts: { blocking: number; warnings: number; acknowledged: number }): Promise<boolean> {
    if (!orgId || received === 0) return true
    try {
      await app.actions.call('record_import_run', { id, org_id: orgId, kind, received_count: received, saved_count: saved, rejected_count: received - saved, status, source_sha256: fileDigest || null, blocking_count: counts.blocking, warning_count: counts.warnings, acknowledged_count: counts.acknowledged })
    } catch { return false }
    return recordAudit(app, { orgId, action: kind === 'fixtures' ? 'upsert_imported_fixture' : 'upsert_imported_roster_player', targetType: 'import_run', targetId: id, outcome: status === 'saved' ? 'succeeded' : 'refused' })
  }

  async function save() {
    setBusy(true); setMessage('')
    const orgIds = [...new Set(fixtures.map((row) => row.org_id).filter((value): value is string => Boolean(value)))]
    const orgId = orgIds[0]
    const counts = { blocking: blocking.length, warnings: warnings.length, acknowledged: acknowledged.length }
    try {
      if (orgIds.length > 1) throw new Error('Import one club at a time.')
      if (!reviewComplete) throw new Error('Resolve every blocking issue and accept every warning before saving.')
      for (const row of fixtures) {
        if (row.issue) throw new Error('Fix all fixture validation errors before saving.')
        await app.actions.call('reconcile_imported_fixture_time', { org_id: row.org_id, round_label: row.round.trim(), home_team_id: row.home_team_id, away_team_id: row.away_team_id, starts_at: row.starts_at, time_status: row.timing_status, arrival_at: row.arrival_at, source_row: row.source_row, source_date_raw: row.source_date_raw, source_time_raw: row.start_time ?? '', import_run_id: runId })
        await app.actions.call('upsert_imported_fixture', { id: crypto.randomUUID(), org_id: row.org_id, home_team_id: row.home_team_id, away_team_id: row.away_team_id, venue_id: row.venue_id, starts_at: row.starts_at, round_label: row.round.trim(), season: row.season.trim(), time_status: row.timing_status, arrival_at: row.arrival_at, source_row: row.source_row, source_date_raw: row.source_date_raw, source_time_raw: row.start_time ?? '', import_run_id: runId, warning_count: warnings.length })
      }
      for (const row of roster) {
        if (row.issue) throw new Error('Fix all roster validation errors before saving.')
        const fixture = fixtures.find((item) => item.date === row.fixture_date && item.round.trim().toLowerCase() === row.fixture_round.trim().toLowerCase() && (item.opponent.trim().toLowerCase() === row.fixture_opponent.trim().toLowerCase() || item.team.trim().toLowerCase() === row.fixture_opponent.trim().toLowerCase()))
        if (!fixture?.org_id) throw new Error('A roster entry refers to an unimported fixture.')
        await app.actions.call('upsert_imported_roster_player', { id: crypto.randomUUID(), org_id: fixture.org_id, starts_at: fixture.starts_at, round_label: fixture.round.trim(), team: fixture.team.trim(), opponent: fixture.opponent.trim(), player_name: row.player_name.trim(), contact: row.contact.trim() })
      }
      const recorded = [await recordImport(orgId, 'fixtures', fixtures.length, fixtures.length, 'saved', runId, counts), await recordImport(orgId, 'roster', roster.length, roster.length, 'saved', crypto.randomUUID(), counts)]
      setMessage(`Saved ${fixtures.length} fixture rows and ${roster.length} roster rows.${recorded.every(Boolean) ? '' : ' The import report could not be written.'}`)
    } catch (error) {
      await recordImport(orgId, 'fixtures', fixtures.length, 0, 'rejected', runId, counts)
      setMessage(error instanceof Error ? error.message : 'Import failed. Please check your files and try again.')
    }
    finally { setBusy(false) }
  }

  const clientIssues = fixtures.some((row) => row.issue) || roster.some((row) => row.issue)
  const invalid = clientIssues || !reviewComplete || (!fixtures.length && !roster.length)
  return <main className="mx-auto w-full max-w-5xl px-4 py-8 sm:px-6"><h1 className="display-font text-3xl font-bold text-[var(--ink)]">Import fixtures and team roster</h1><p className="mt-2 text-sm text-[var(--muted)]">Upload CSV exports. Player names and contact details stay out of the preview.</p>
    {authorized === null && <button onClick={() => void loadOptions()} disabled={busy} className="mt-5 min-h-11 rounded-xl bg-[var(--accent)] px-4 font-semibold text-white">{busy ? 'Checking access…' : 'Check manager access'}</button>}
    {authorized === false && <p className="mt-5 rounded-xl bg-[var(--danger)]/10 p-4 text-sm text-[var(--danger)]">This page is for club managers and admins.</p>}
    {authorized && <><div className="mt-6 grid gap-4 sm:grid-cols-2"><label className="rounded-2xl border border-[var(--line)] bg-[var(--surface)] p-4 text-sm font-semibold">Fixture book CSV<input className="mt-3 block w-full text-sm" type="file" accept=".csv,text/csv" onChange={(event) => void readFixtureFile(event.target.files?.[0])} /><span className="mt-2 block text-xs font-normal text-[var(--muted)]">date, round, opponent, home_away, venue, team, season; optional start_time (HH:MM), time_status (confirmed, estimated or tbc), arrival_time (HH:MM), timezone</span></label><label className="rounded-2xl border border-[var(--line)] bg-[var(--surface)] p-4 text-sm font-semibold">Team roster CSV<input className="mt-3 block w-full text-sm" type="file" accept=".csv,text/csv" onChange={(event) => void readRosterFile(event.target.files?.[0])} /><span className="mt-2 block text-xs font-normal text-[var(--muted)]">player_name, contact, team, fixture_round, fixture_opponent, fixture_date</span></label></div>
      {fixtures.length > 0 && <section className="mt-7"><h2 className="text-xl font-bold text-[var(--ink)]">Fixture preview ({fixtures.length})</h2><p className="mt-1 text-sm text-[var(--muted)]">Rows without a confirmed start time are saved as TBC, never as a confirmed time. Arrival times are stored separately from the start.</p><div className="mt-3 overflow-x-auto rounded-2xl border border-[var(--line)]"><table className="w-full text-left text-sm"><thead className="bg-[var(--paper-deep)]"><tr>{['Line', 'Date', 'Start', 'Status', 'Arrival', 'Round', 'Team', 'Home/away', 'Opponent', 'Venue', 'Client check'].map((heading) => <th key={heading} className="p-3">{heading}</th>)}</tr></thead><tbody>{fixtures.map((row) => <tr key={row.source_row} className="border-t border-[var(--line)]"><td className="p-3">{row.source_row}</td><td className="p-3">{row.source_date_raw}</td><td className="p-3">{row.timing_status === 'tbc' ? 'TBC' : row.starts_at.slice(11, 16)}</td><td className="p-3">{row.timing_status}</td><td className="p-3">{row.arrival_at ? row.arrival_at.slice(11, 16) : '—'}</td><td className="p-3">{row.round}</td><td className="p-3">{row.team}</td><td className="p-3">{row.home_away}</td><td className="p-3">{row.opponent}</td><td className="p-3">{row.venue}</td><td className="p-3 text-[var(--danger)]">{row.issue || 'Ready'}</td></tr>)}</tbody></table></div>
        <button onClick={() => void check()} disabled={busy} className="mt-4 min-h-11 rounded-xl border border-[var(--line)] bg-[var(--surface)] px-4 font-semibold text-[var(--ink)]">{busy ? 'Checking…' : 'Check import for conflicts'}</button>
        {issues !== null && <div className="mt-5"><p className="text-sm font-semibold text-[var(--ink)]">{blocking.length} blocking, {warnings.length} warnings, {acknowledged.length} accepted. Blocking issues must be fixed in the source file; warnings need an explicit acceptance.</p>{issues.length > 0 && <div className="mt-3 overflow-x-auto rounded-2xl border border-[var(--line)]"><table className="w-full text-left text-sm"><thead className="bg-[var(--paper-deep)]"><tr>{['Line', 'Severity', 'Issue', 'Remediation', 'Decision'].map((heading) => <th key={heading} className="p-3">{heading}</th>)}</tr></thead><tbody>{issues.map((issue) => <tr key={issueKey(issue)} className="border-t border-[var(--line)]"><td className="p-3">{issue.source_row}</td><td className={`p-3 font-semibold ${issue.severity === 'blocking' ? 'text-[var(--danger)]' : 'text-[var(--ink)]'}`}>{issue.severity}</td><td className="p-3">{issue.message}</td><td className="p-3 text-[var(--muted)]">{issue.remediation}</td><td className="p-3">{issue.severity === 'blocking' ? 'Fix in source' : acknowledged.includes(issueKey(issue)) ? 'Accepted' : <button disabled={busy} onClick={() => void acknowledge(issue)} className="min-h-11 rounded-xl border border-[var(--line)] px-3 font-semibold text-[var(--ink)]">Accept warning</button>}</td></tr>)}</tbody></table></div>}</div>}
      </section>}
      {roster.length > 0 && <p className="mt-5 rounded-xl bg-[var(--mint-soft)] p-4 text-sm text-[var(--mint-deep)]">Roster file loaded: {roster.length} entries. Names and contact details are hidden from this preview.</p>}
      <button disabled={busy || invalid} onClick={() => void save()} className="mt-6 min-h-11 rounded-xl bg-[var(--accent)] px-5 font-semibold text-white disabled:opacity-50">{busy ? 'Saving…' : 'Validate and save import'}</button>
    </>}{message && <p className="mt-4 rounded-xl bg-[var(--paper-deep)] p-4 text-sm text-[var(--ink)]" role="status">{message}</p>}</main>
}

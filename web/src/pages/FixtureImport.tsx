import { useState } from 'react'
import type { ProAppStore } from '@proappstore/sdk'
import { recordAudit } from './auditTrail'
import { mapFixtureRows, melbourneFixtureStart, normalizeDate, parseCsv, type FixtureOption, type FixtureRow } from './fixtureImportLogic'

type Option = FixtureOption
type RosterRow = { player_name: string; contact: string; team: string; fixture_round: string; fixture_opponent: string; fixture_date: string; issue?: string }

export default function FixtureImport({ app }: { app: ProAppStore }) {
  const [options, setOptions] = useState<Option[]>([])
  const [fixtures, setFixtures] = useState<FixtureRow[]>([])
  const [roster, setRoster] = useState<RosterRow[]>([])
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [authorized, setAuthorized] = useState<boolean | null>(null)

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
    const parsed = parseCsv(await file.text())
    setFixtures(mapFixtureRows(parsed, options))
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

  async function recordImport(orgId: string | undefined, kind: 'fixtures' | 'roster', received: number, saved: number, status: 'saved' | 'rejected'): Promise<boolean> {
    if (!orgId || received === 0) return true
    const runId = crypto.randomUUID()
    try {
      await app.actions.call('record_import_run', { id: runId, org_id: orgId, kind, received_count: received, saved_count: saved, rejected_count: received - saved, status })
    } catch { return false }
    return recordAudit(app, { orgId, action: kind === 'fixtures' ? 'upsert_imported_fixture' : 'upsert_imported_roster_player', targetType: 'import_run', targetId: runId, outcome: status === 'saved' ? 'succeeded' : 'refused' })
  }

  async function save() {
    setBusy(true); setMessage('')
    const orgIds = [...new Set(fixtures.map((row) => row.org_id).filter((value): value is string => Boolean(value)))]
    const orgId = orgIds[0]
    try {
      if (orgIds.length > 1) throw new Error('Import one club at a time.')
      for (const row of fixtures) {
        if (row.issue) throw new Error('Fix all fixture validation errors before saving.')
        await app.actions.call('upsert_imported_fixture', { id: crypto.randomUUID(), org_id: row.org_id, home_team_id: row.home_team_id, away_team_id: row.away_team_id, venue_id: row.venue_id, starts_at: melbourneFixtureStart(row.date), round_label: row.round.trim(), season: row.season.trim() })
      }
      for (const row of roster) {
        if (row.issue) throw new Error('Fix all roster validation errors before saving.')
        const fixture = fixtures.find((item) => item.date === row.fixture_date && item.round.trim().toLowerCase() === row.fixture_round.trim().toLowerCase() && (item.opponent.trim().toLowerCase() === row.fixture_opponent.trim().toLowerCase() || item.team.trim().toLowerCase() === row.fixture_opponent.trim().toLowerCase()))
        if (!fixture?.org_id) throw new Error('A roster entry refers to an unimported fixture.')
        await app.actions.call('upsert_imported_roster_player', { id: crypto.randomUUID(), org_id: fixture.org_id, starts_at: melbourneFixtureStart(fixture.date), round_label: fixture.round.trim(), team: fixture.team.trim(), opponent: fixture.opponent.trim(), player_name: row.player_name.trim(), contact: row.contact.trim() })
      }
      const recorded = [await recordImport(orgId, 'fixtures', fixtures.length, fixtures.length, 'saved'), await recordImport(orgId, 'roster', roster.length, roster.length, 'saved')]
      setMessage(`Saved ${fixtures.length} fixture rows and ${roster.length} roster rows.${recorded.every(Boolean) ? '' : ' The import report could not be written.'}`)
    } catch (error) {
      await recordImport(orgId, 'fixtures', fixtures.length, 0, 'rejected')
      setMessage(error instanceof Error ? error.message : 'Import failed. Please check your files and try again.')
    }
    finally { setBusy(false) }
  }

  const invalid = fixtures.some((row) => row.issue) || roster.some((row) => row.issue) || (!fixtures.length && !roster.length)
  return <main className="mx-auto w-full max-w-5xl px-4 py-8 sm:px-6"><h1 className="display-font text-3xl font-bold text-[var(--ink)]">Import fixtures and team roster</h1><p className="mt-2 text-sm text-[var(--muted)]">Upload CSV exports. Player names and contact details stay out of the preview.</p>
    {authorized === null && <button onClick={() => void loadOptions()} disabled={busy} className="mt-5 min-h-11 rounded-xl bg-[var(--accent)] px-4 font-semibold text-white">{busy ? 'Checking access…' : 'Check manager access'}</button>}
    {authorized === false && <p className="mt-5 rounded-xl bg-[var(--danger)]/10 p-4 text-sm text-[var(--danger)]">This page is for club managers and admins.</p>}
    {authorized && <><div className="mt-6 grid gap-4 sm:grid-cols-2"><label className="rounded-2xl border border-[var(--line)] bg-[var(--surface)] p-4 text-sm font-semibold">Fixture book CSV<input className="mt-3 block w-full text-sm" type="file" accept=".csv,text/csv" onChange={(event) => void readFixtureFile(event.target.files?.[0])} /><span className="mt-2 block text-xs font-normal text-[var(--muted)]">date, round, opponent, home_away, venue, team, season</span></label><label className="rounded-2xl border border-[var(--line)] bg-[var(--surface)] p-4 text-sm font-semibold">Team roster CSV<input className="mt-3 block w-full text-sm" type="file" accept=".csv,text/csv" onChange={(event) => void readRosterFile(event.target.files?.[0])} /><span className="mt-2 block text-xs font-normal text-[var(--muted)]">player_name, contact, team, fixture_round, fixture_opponent, fixture_date</span></label></div>
      {fixtures.length > 0 && <section className="mt-7"><h2 className="text-xl font-bold text-[var(--ink)]">Fixture preview ({fixtures.length})</h2><div className="mt-3 overflow-x-auto rounded-2xl border border-[var(--line)]"><table className="w-full text-left text-sm"><thead className="bg-[var(--paper-deep)]"><tr>{['Date', 'Round', 'Team', 'Home/away', 'Opponent', 'Venue', 'Validation'].map((heading) => <th key={heading} className="p-3">{heading}</th>)}</tr></thead><tbody>{fixtures.map((row, index) => <tr key={index} className="border-t border-[var(--line)]"><td className="p-3">{row.date}</td><td className="p-3">{row.round}</td><td className="p-3">{row.team}</td><td className="p-3">{row.home_away}</td><td className="p-3">{row.opponent}</td><td className="p-3">{row.venue}</td><td className="p-3 text-[var(--danger)]">{row.issue || 'Ready'}</td></tr>)}</tbody></table></div></section>}
      {roster.length > 0 && <p className="mt-5 rounded-xl bg-[var(--mint-soft)] p-4 text-sm text-[var(--mint-deep)]">Roster file loaded: {roster.length} entries. Names and contact details are hidden from this preview.</p>}
      <button disabled={busy || invalid} onClick={() => void save()} className="mt-6 min-h-11 rounded-xl bg-[var(--accent)] px-5 font-semibold text-white disabled:opacity-50">{busy ? 'Saving…' : 'Validate and save import'}</button>
    </>}{message && <p className="mt-4 rounded-xl bg-[var(--paper-deep)] p-4 text-sm text-[var(--ink)]" role="status">{message}</p>}</main>
}

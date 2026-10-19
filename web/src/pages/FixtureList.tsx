import { useEffect, useMemo, useState } from 'react'
import type { ProAppStore } from '@proappstore/sdk'
import { fixtureArrivalLabel, fixtureListStart, fixtureStartLabel, localDayStart } from '../fixtureTime'
import { fixturesLoadMessage } from './fixtureListMessages'
import { completedScoreLabel } from '../fixtureResult'

type Fixture = { id: string; starts_at: string; time_status: string | null; arrival_at: string | null; round_label: string | null; status: string; home_score: number | null; away_score: number | null; home_team_id: string; away_team_id: string; season_id: string | null; season_name: string | null; home_team_name: string; away_team_name: string; venue_name: string | null; venue_address: string | null; member_side: 'home' | 'away' | null; opponent_name: string | null; is_external_opponent: number | null }
export type HistoryMode = 'upcoming' | 'past' | 'all'
export type HistoryFilters = { mode: HistoryMode; teamId: string; seasonId: string; resultStatus: string; dateFrom: string; dateTo: string }
type Option = { id: string; name: string }

const MODES: [HistoryMode, string][] = [['upcoming', 'Upcoming'], ['past', 'Past'], ['all', 'All']]
const STATUSES: [string, string][] = [['', 'All statuses'], ['scheduled', 'Scheduled'], ['complete', 'Complete'], ['washout', 'Washout'], ['heat_out', 'Heat out'], ['forfeit', 'Forfeit']]
const field = 'min-h-11 w-full rounded-xl border border-[var(--line)] bg-[var(--surface)] px-3 text-sm text-[var(--ink)]'

// Server parameters for one view. Upcoming and past split on `from` (today); the date range is separate.
export function historyParams(filters: HistoryFilters, now = new Date()) {
  return {
    from: fixtureListStart(now),
    mode: filters.mode,
    limit: 50,
    team_id: filters.teamId,
    season_id: filters.seasonId,
    result_status: filters.resultStatus,
    date_from: filters.dateFrom ? localDayStart(filters.dateFrom) : '',
    to: filters.dateTo ? localDayStart(filters.dateTo, 1) : '',
  }
}

// Options are collected from the fixtures seen so far, so a filter does not hide the other teams or seasons.
function mergeOptions(current: Option[], found: Option[]): Option[] {
  const byId = new Map(current.map((option) => [option.id, option]))
  for (const option of found) byId.set(option.id, option)
  return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name))
}

export default function FixtureList({ app }: { app: ProAppStore }) {
  const [fixtures, setFixtures] = useState<Fixture[]>([])
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [mode, setMode] = useState<HistoryMode>('upcoming')
  const [teamId, setTeamId] = useState('')
  const [seasonId, setSeasonId] = useState('')
  const [resultStatus, setResultStatus] = useState('')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [teamOptions, setTeamOptions] = useState<Option[]>([])
  const [seasonOptions, setSeasonOptions] = useState<Option[]>([])

  const params = useMemo(() => historyParams({ mode, teamId, seasonId, resultStatus, dateFrom, dateTo }), [mode, teamId, seasonId, resultStatus, dateFrom, dateTo])
  const filtersApplied = Boolean(teamId || seasonId || resultStatus || dateFrom || dateTo)

  useEffect(() => {
    let active = true
    setLoading(true); setError('')
    app.actions.call<{ rows: Fixture[] }>('list_my_fixtures', params)
      .then((result) => { if (active) setFixtures(result.rows ?? []) })
      .catch((failure) => { if (active) setError(fixturesLoadMessage(failure)) })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [app, params])

  useEffect(() => {
    // The member's own team in each fixture is the one they can filter by.
    setTeamOptions((current) => mergeOptions(current, fixtures.map((fixture) => fixture.member_side === 'away'
      ? { id: fixture.away_team_id, name: fixture.away_team_name }
      : { id: fixture.home_team_id, name: fixture.home_team_name })))
    setSeasonOptions((current) => mergeOptions(current, fixtures.filter((fixture) => fixture.season_id).map((fixture) => ({ id: fixture.season_id!, name: fixture.season_name ?? 'Season' }))))
  }, [fixtures])

  const emptyMessage = filtersApplied ? 'No fixtures match these filters.' : mode === 'past' ? 'No past fixtures are available for your teams.' : mode === 'all' ? 'No fixtures are available for your teams.' : 'No upcoming fixtures are available for your teams.'

  return <main className="container-app py-8"><h1 className="display-font text-3xl font-bold text-[var(--ink)]">Fixtures</h1><p className="mt-2 text-sm text-[var(--muted)]">Fixtures for teams you belong to. Player and contact records are not shown here.</p>

    <div role="tablist" aria-label="Fixture period" className="mt-5 inline-flex rounded-xl border border-[var(--line)] bg-[var(--surface)] p-1">
      {MODES.map(([value, label]) => <button key={value} role="tab" id={`fixtures-tab-${value}`} aria-selected={mode === value} aria-controls="fixtures-panel" tabIndex={mode === value ? 0 : -1} onClick={() => setMode(value)} className={`min-h-11 rounded-lg px-4 text-sm font-semibold ${mode === value ? 'bg-[var(--accent)] text-[var(--on-accent)]' : 'text-[var(--ink)] hover:bg-[var(--paper-deep)]'}`}>{label}</button>)}
    </div>

    <form className="mt-4 grid gap-3 rounded-2xl border border-[var(--line)] bg-[var(--surface)] p-4 sm:grid-cols-2 lg:grid-cols-5" aria-label="Filter fixtures" onSubmit={(event) => event.preventDefault()}>
      <label className="text-sm font-semibold text-[var(--ink)]">Team<select className={field} value={teamId} onChange={(e) => setTeamId(e.target.value)}><option value="">All my teams</option>{teamOptions.map((team) => <option key={team.id} value={team.id}>{team.name}</option>)}</select></label>
      <label className="text-sm font-semibold text-[var(--ink)]">Season<select className={field} value={seasonId} onChange={(e) => setSeasonId(e.target.value)}><option value="">All seasons</option>{seasonOptions.map((season) => <option key={season.id} value={season.id}>{season.name}</option>)}</select></label>
      <label className="text-sm font-semibold text-[var(--ink)]">Result status<select className={field} value={resultStatus} onChange={(e) => setResultStatus(e.target.value)}>{STATUSES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      <label className="text-sm font-semibold text-[var(--ink)]">From date<input type="date" className={field} value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} /></label>
      <label className="text-sm font-semibold text-[var(--ink)]">To date<input type="date" className={field} value={dateTo} onChange={(e) => setDateTo(e.target.value)} /></label>
      {filtersApplied && <button type="button" onClick={() => { setTeamId(''); setSeasonId(''); setResultStatus(''); setDateFrom(''); setDateTo('') }} className="min-h-11 rounded-xl border border-[var(--line)] px-4 text-sm font-semibold text-[var(--ink)] sm:col-span-2 lg:col-span-5">Clear filters</button>}
    </form>

    <div id="fixtures-panel" role="tabpanel" aria-labelledby={`fixtures-tab-${mode}`}>
    {error && <p className="mt-5 rounded-xl bg-[var(--danger)]/10 p-4 text-sm text-[var(--danger-ink)]">{error}</p>}
    {loading ? <p className="mt-5 text-sm text-[var(--muted)]" role="status">Loading fixtures…</p> : error ? null : fixtures.length === 0 ? <p className="mt-5 rounded-2xl border border-dashed border-[var(--line-strong)] p-8 text-center text-sm text-[var(--muted)]">{emptyMessage}</p> : <div className="mt-5 grid gap-3">{fixtures.map((fixture) => <article key={fixture.id} className="rounded-2xl border border-[var(--line)] bg-[var(--surface)] p-4 shadow-sm"><div className="flex flex-wrap items-baseline justify-between gap-2"><h2 className="font-bold text-[var(--ink)]">{fixture.home_team_name} <span className="font-medium text-[var(--muted)]">vs</span> {fixture.away_team_name}</h2><span className="text-xs font-semibold text-[var(--accent)]">{fixture.round_label ?? 'Fixture'}</span></div><p className="mt-2 text-sm text-[var(--muted)]">{fixtureStartLabel(fixture)}{fixtureArrivalLabel(fixture) ? ` · ${fixtureArrivalLabel(fixture)}` : ''} · {fixture.venue_name ?? 'Venue to be confirmed'}{fixture.venue_address ? ` · ${fixture.venue_address}` : ''}</p><p className="mt-1 text-xs text-[var(--muted)]">{fixture.home_team_name} is home</p>{completedScoreLabel(fixture) && <p className="mt-2 text-sm font-bold text-[var(--ink)]">Result: {completedScoreLabel(fixture)}</p>}{fixture.member_side && <p className="mt-1 text-xs font-semibold text-[var(--accent-deep)]">Your team: {fixture.member_side === 'home' ? fixture.home_team_name : fixture.away_team_name}</p>}{fixture.member_side && <p className="mt-1 text-xs font-semibold text-[var(--muted)]">Opponent: {fixture.opponent_name ?? fixture.away_team_name}{fixture.is_external_opponent ? ' (external club)' : ''}</p>}</article>)}</div>}
    </div>
  </main>
}

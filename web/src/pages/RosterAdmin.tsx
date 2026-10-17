import { useEffect, useState } from 'react'
import { PageHeader } from '@proappstore/sdk'
import { outcomeOf, recordAudit, type AuditOutcome } from './auditTrail'
import { fixtureStartLabel } from '../fixtureTime'
import { listAllRows } from './listAllRows'

type AppClient = { actions: { call<T = unknown>(name: string, values: Record<string, unknown>): Promise<T> }; storage: { uploadForReview(path: string, data: Blob, contentType?: string): Promise<{ key: string }>; downloadForReview(userId: string, path: string): Promise<Response> }; auth: { user: { id: string } | null } }
type Fixture = { id: string; org_id: string; starts_at: string; time_status: string | null; arrival_at: string | null; source_row: number | null; source_date_raw: string | null; source_time_raw: string | null; round_label: string | null; status: string; status_updated_at: number | null; match_notice: string | null; home_score: number | null; away_score: number | null; home_team_name: string; away_team_name: string; opponent_name: string | null; is_external_opponent: number | null; home_team_id: string; away_team_id: string; in_count: number; out_count: number; pending_count: number }
type Selection = 'selected' | 'pending' | 'unavailable' | 'emergency_call_up'
type Player = { user_id: string; display_name: string; availability: 'in' | 'out' | 'pending'; selection: Selection | null; pool: 'regular' | 'emergency' | null; updated_at: number | null }
type Candidate = { user_id: string; display_name: string; pool?: 'regular' | 'emergency' | null }
type SquadMember = { team_id: string; user_id: string; display_name: string; pool: 'regular' | 'emergency'; is_active: number; updated_at: number | null }
type SelectionChange = { id: string; user_id: string; display_name: string; old_selection: Selection | null; new_selection: Selection; actor_user_id: string; created_at: number }
type Activity = { user_id: string; display_name: string; action: string; old_availability: string | null; new_availability: string | null; created_at: number }
type Result = { id: string; home_score: number; away_score: number; set_results: string | null; scorecard_user_id: string | null; scorecard_path: string | null; submitted_at: number; correction_note: string | null }
type ResultFixture = { fixture_id: string; card_state: string; home_score: number | null; away_score: number | null; submitted_at: number | null; scorecard_user_id: string | null; scorecard_path: string | null; home_team_name: string; away_team_name: string }
const field = 'min-h-11 w-full rounded-xl border border-[var(--line)] bg-[var(--surface)] px-3 text-sm text-[var(--ink)]'
const selectionLabel = (value: string | null | undefined) => ({ selected: 'Selected', pending: 'Selection pending', unavailable: 'Unavailable', emergency_call_up: 'Emergency call-up' } as Record<string, string>)[value ?? 'selected'] ?? 'Selected'
const selectionOptionsFor = (pool: string | null | undefined): [Selection, string][] => pool === 'emergency' ? [['emergency_call_up', 'Emergency call-up']] : [['selected', 'Selected'], ['pending', 'Selection pending'], ['unavailable', 'Unavailable']]
const defaultSelectionFor = (pool: string | null | undefined): Selection => pool === 'emergency' ? 'emergency_call_up' : 'selected'
const stamp = (value: number | null) => value ? new Intl.DateTimeFormat('en-AU', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value < 1e12 ? value * 1000 : value)) : 'No reply yet'

export default function RosterAdmin({ app }: { app: AppClient }) {
  const [fixtures, setFixtures] = useState<Fixture[]>([])
  const [fixtureId, setFixtureId] = useState('')
  const [players, setPlayers] = useState<Player[]>([])
  const [candidates, setCandidates] = useState<Candidate[]>([])
  const [activity, setActivity] = useState<Activity[]>([])
  const [resultHistory, setResultHistory] = useState<Result[]>([])
  const [cardState, setCardState] = useState('missing')
  const [candidateId, setCandidateId] = useState('')
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [squad, setSquad] = useState<SquadMember[]>([])
  const [selectionHistory, setSelectionHistory] = useState<SelectionChange[]>([])
  const [selectionState, setSelectionState] = useState<Selection>('selected')

  async function audit(action: string, targetType: string, targetId: string, outcome: AuditOutcome) {
    const orgId = fixtures.find((fixture) => fixture.id === fixtureId)?.org_id
    return orgId ? recordAudit(app, { orgId, action, targetType, targetId, outcome }) : false
  }
  async function loadFixtures() {
    try {
      // Every page, so a fixture beyond the first 100 can still be rostered.
      const rows = await listAllRows<Fixture>((offset) => app.actions.call<{ rows: Fixture[] }>('list_managed_fixtures', { limit: 100, offset }))
      setFixtures(rows); setFixtureId((current) => rows.some((x) => x.id === current) ? current : rows[0]?.id ?? '')
      setError('')
    } catch { setError('Managed fixtures could not be loaded. Sign in with a club manager or administrator account.') }
  }
  async function loadRoster(id = fixtureId) {
    if (!id) { setPlayers([]); setCandidates([]); setActivity([]); return }
    try {
      const [r, c, a] = await Promise.all([
        app.actions.call<{ rows: Player[] }>('list_managed_fixture_roster', { fixture_id: id }),
        app.actions.call<{ rows: Candidate[] }>('list_fixture_team_candidates', { fixture_id: id }),
        app.actions.call<{ rows: Activity[] }>('list_fixture_roster_activity', { fixture_id: id }),
      ])
      const roster = r.rows ?? []; setPlayers(roster); setCandidates(c.rows ?? []); setActivity(a.rows ?? [])
      const [results, status] = await Promise.all([
        app.actions.call<{ rows: Result[] }>('list_fixture_result_history', { fixture_id: id }),
        app.actions.call<{ rows: ResultFixture[] }>('list_managed_fixture_results', {}),
      ])
      setResultHistory(results.rows ?? []); setCardState(status.rows?.find((x) => x.fixture_id === id)?.card_state ?? 'missing')
      const fixture = fixtures.find((x) => x.id === id)
      if (fixture) {
        const [squadResults, history] = await Promise.all([
          Promise.all([fixture.home_team_id, fixture.away_team_id].map((team) => app.actions.call<{ rows: SquadMember[] }>('list_team_pool', { org_id: fixture.org_id, team_id: team }))),
          app.actions.call<{ rows: SelectionChange[] }>('list_fixture_selection_history', { org_id: fixture.org_id, fixture_id: id }),
        ])
        setSquad(squadResults.flatMap((result) => result.rows ?? [])); setSelectionHistory(history.rows ?? [])
      }
      // The picked candidate sets the selection default too: an emergency player can only be called up, so 'selected' would be refused.
      const eligible = (c.rows ?? []).filter((x) => !roster.some((p) => p.user_id === x.user_id))
      const picked = eligible.find((x) => x.user_id === candidateId) ?? eligible[0]
      setCandidateId(picked?.user_id ?? '')
      setSelectionState(defaultSelectionFor(picked?.pool))
    } catch { setError('This fixture roster could not be loaded.') }
  }
  useEffect(() => { void loadFixtures() }, [app])
  useEffect(() => { void loadRoster(fixtureId) }, [fixtureId])
  async function mutate(action: 'add_fixture_roster_player' | 'remove_fixture_roster_player', userId: string, selection: Selection = 'selected') {
    if (!fixtureId) return
    setBusy(true); setError(''); setMessage('')
    try {
      const previousPlayer = players.find((player) => player.user_id === userId)
      const values = action === 'add_fixture_roster_player' ? { fixture_id: fixtureId, user_id: userId, selection } : { fixture_id: fixtureId, user_id: userId }
      const result = await app.actions.call(action, values)
      // A refused write changed no rows (for example the player is not in the squad), so nothing is logged as done.
      if (outcomeOf(result) === 'refused') throw new Error('The roster change was not applied.')
      if (action === 'add_fixture_roster_player') {
        if (!previousPlayer) await app.actions.call('log_fixture_roster_added', { fixture_id: fixtureId, user_id: userId })
        await app.actions.call('log_fixture_selection_change', { id: crypto.randomUUID(), org_id: selected?.org_id, fixture_id: fixtureId, user_id: userId, old_selection: previousPlayer?.selection ?? null })
      } else if (previousPlayer) {
        await app.actions.call('log_fixture_roster_removed', { fixture_id: fixtureId, user_id: userId, old_availability: previousPlayer.availability })
      }
      const audited = await audit(action, 'fixture_roster_player', `${fixtureId}:${userId}`, outcomeOf(result))
      await Promise.all([loadRoster(), loadFixtures()])
      const done = action.startsWith('add') ? (previousPlayer ? 'Selection updated.' : 'Player added to the fixture roster.') : 'Player removed from this fixture roster.'
      setMessage(audited ? done : `${done} The audit record could not be written.`)
    }
    catch {
      await audit(action, 'fixture_roster_player', `${fixtureId}:${userId}`, 'refused')
      setError('The roster change could not be saved.')
    }
    finally { setBusy(false) }
  }
  async function changePool(member: SquadMember, pool: 'regular' | 'emergency') {
    if (!selected || pool === member.pool) return
    setBusy(true); setError(''); setMessage('')
    try {
      const result = await app.actions.call('set_team_player_pool', { org_id: selected.org_id, team_id: member.team_id, user_id: member.user_id, pool })
      const outcome = outcomeOf(result)
      if (outcome === 'succeeded') await app.actions.call('log_team_pool_change', { id: crypto.randomUUID(), org_id: selected.org_id, team_id: member.team_id, user_id: member.user_id, display_name: member.display_name, action: 'pool_set', old_pool: member.pool, new_pool: pool })
      const audited = await recordAudit(app, { orgId: selected.org_id, action: 'set_team_player_pool', targetType: 'team_player', targetId: `${member.team_id}:${member.user_id}`, outcome })
      await loadRoster()
      if (outcome === 'refused') setError(`${member.display_name} was not moved. Check the squad and try again.`)
      else setMessage(audited ? `${member.display_name} moved to the ${pool === 'emergency' ? 'emergency' : 'regular'} pool.` : 'Pool updated. The audit record could not be written.')
    } catch {
      setError('The squad change could not be saved.')
    } finally { setBusy(false) }
  }
  async function leaveSquad(member: SquadMember) {
    if (!selected) return
    setBusy(true); setError(''); setMessage('')
    try {
      const result = await app.actions.call('deactivate_team_player', { org_id: selected.org_id, team_id: member.team_id, user_id: member.user_id })
      const outcome = outcomeOf(result)
      if (outcome === 'succeeded') await app.actions.call('log_team_pool_change', { id: crypto.randomUUID(), org_id: selected.org_id, team_id: member.team_id, user_id: member.user_id, display_name: member.display_name, action: 'deactivated', old_pool: member.pool, new_pool: null })
      const audited = await recordAudit(app, { orgId: selected.org_id, action: 'deactivate_team_player', targetType: 'team_player', targetId: `${member.team_id}:${member.user_id}`, outcome })
      await loadRoster()
      if (outcome === 'refused') setError(`${member.display_name} was not removed from the squad. Check the squad and try again.`)
      else setMessage(audited ? `${member.display_name} has left the active squad.` : 'Squad updated. The audit record could not be written.')
    } catch {
      setError('The squad change could not be saved.')
    } finally { setBusy(false) }
  }
  async function saveMatchDay(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!fixtureId) return
    const form = new FormData(event.currentTarget)
    setBusy(true); setError(''); setMessage('')
    try {
      const result = await app.actions.call('update_fixture_match_day', { fixture_id: fixtureId, status: String(form.get('status')), match_notice: String(form.get('match_notice') ?? '') })
      const outcome = outcomeOf(result)
      const audited = await audit('update_fixture_match_day', 'fixture', fixtureId, outcome)
      await loadFixtures()
      if (outcome === 'refused') setError('The match-day update was not published. Check your club role and try again.')
      else setMessage(audited ? 'Match-day status and notice published.' : 'Match-day status and notice published. The audit record could not be written.')
    } catch {
      await audit('update_fixture_match_day', 'fixture', fixtureId, 'refused')
      setError('The match-day update could not be saved.')
    }
    finally { setBusy(false) }
  }
  async function saveResult(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!fixtureId) return
    const form = new FormData(event.currentTarget); const file = form.get('scorecard') as File | null
    setBusy(true); setError(''); setMessage('')
    try {
      const sets = String(form.get('set_results') ?? '').trim()
      if (sets) JSON.parse(sets)
      let scorecardPath: string | null = null; let scorecardUserId: string | null = null
      if (file?.size) {
        if (!['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/heic'].includes(file.type) || file.size > 10 * 1024 * 1024) throw new Error('Choose a PDF or image up to 10 MB.')
        if (!app.auth.user) throw new Error('Sign in again before uploading the scorecard.')
        scorecardPath = `fixture-cards/${fixtureId}/${crypto.randomUUID()}-${file.name.replace(/[^a-zA-Z0-9._-]/g, '_')}`
        await app.storage.uploadForReview(scorecardPath, file, file.type); scorecardUserId = app.auth.user.id
      }
      const submissionId = crypto.randomUUID()
      const submitted = await app.actions.call('submit_fixture_result', { id: submissionId, fixture_id: fixtureId, home_score: Number(form.get('home_score')), away_score: Number(form.get('away_score')), set_results: sets, scorecard_user_id: scorecardUserId, scorecard_path: scorecardPath, correction_note: String(form.get('correction_note') ?? '') })
      const submittedOutcome = outcomeOf(submitted)
      await audit('submit_fixture_result', 'fixture_result', submissionId, submittedOutcome)
      if (submittedOutcome === 'refused') throw new Error('The result was not saved. Check your club role and the scores, then try again.')
      const applied = await app.actions.call('apply_fixture_result_to_fixture', { submission_id: submissionId, fixture_id: fixtureId })
      const appliedOutcome = outcomeOf(applied)
      await audit('apply_fixture_result_to_fixture', 'fixture', fixtureId, appliedOutcome)
      await loadRoster(); await loadFixtures()
      if (appliedOutcome === 'refused') throw new Error('The result was recorded in the history, but the fixture score was not updated. Try again.')
      setMessage('Result submission saved. Earlier submissions remain in the history.')
    } catch (e) { setError(e instanceof Error ? e.message : 'The result could not be saved.') }
    finally { setBusy(false) }
  }
  async function downloadCard(userId: string, path: string) {
    try {
      const response = await app.storage.downloadForReview(userId, path)
      const url = URL.createObjectURL(await response.blob()); const link = document.createElement('a'); link.href = url; link.download = path.split('/').pop() || 'scorecard'; link.click(); URL.revokeObjectURL(url)
    } catch { setError('This scorecard is not available to your account.') }
  }
  const selected = fixtures.find((x) => x.id === fixtureId)
  const eligible = candidates.filter((x) => !players.some((p) => p.user_id === x.user_id))

  return <main className="mx-auto w-full max-w-5xl px-4 py-8 sm:px-6">
    <PageHeader title="Fixture rosters" description="Publish a playing list and track replies from your team." />
    <p className="mt-2 text-sm text-[var(--muted)]">Player names and availability are visible only to members of the fixture teams and their club managers.</p>
    {error && <p className="mt-5 rounded-xl bg-[var(--danger)]/10 p-4 text-sm text-[var(--danger)]" role="alert">{error}</p>}
    {message && <p className="mt-5 rounded-xl bg-[var(--mint-soft)] p-4 text-sm text-[var(--mint-deep)]" role="status">{message}</p>}
    {fixtures.length > 0 ? <>
      <label className="mt-6 block max-w-2xl text-sm font-semibold text-[var(--ink)]">Fixture<select className={field} value={fixtureId} onChange={(e) => setFixtureId(e.target.value)}>{fixtures.map((f) => <option key={f.id} value={f.id}>{fixtureStartLabel(f)} · {f.home_team_name} vs {f.away_team_name}{f.round_label ? ` · ${f.round_label}` : ''}{f.is_external_opponent ? ' · external opponent' : ''}</option>)}</select></label>
      {selected && selected.source_row ? <p className="mt-3 text-sm text-[var(--muted)]">Imported from source line {selected.source_row}: date as given “{selected.source_date_raw}”{selected.source_time_raw ? `, time as given “${selected.source_time_raw}”` : ''}. Time status: {selected.time_status}.</p> : null}
      {selected && <section className="mt-5 grid grid-cols-3 gap-3"><Count label="In" value={selected.in_count} /><Count label="Out" value={selected.out_count} /><Count label="Pending" value={selected.pending_count} /></section>}
      {selected && <form onSubmit={(event) => void saveMatchDay(event)} className="mt-5 grid gap-3 rounded-2xl border border-[var(--line)] bg-[var(--surface)] p-5"><h2 className="font-bold text-[var(--ink)]">Match-day update</h2><p className="text-sm text-[var(--muted)]">Record the status and share a short factual notice with team members. Scores already entered are preserved.</p><label className="text-sm font-semibold text-[var(--ink)]">Status<select name="status" defaultValue={selected.status} className={field}>{[['scheduled','Scheduled'],['washout','Washout'],['heat_out','Heat-out'],['forfeit','Forfeit'],['complete','Complete']].map(([value,label]) => <option key={value} value={value}>{label}</option>)}</select></label><label className="text-sm font-semibold text-[var(--ink)]">Player notice<textarea name="match_notice" maxLength={280} defaultValue={selected.match_notice ?? ''} placeholder="Optional update for players" className={`${field} min-h-20 py-3`} /></label>{selected.status_updated_at && <p className="text-xs text-[var(--muted)]">Last updated {stamp(selected.status_updated_at)}</p>}<button disabled={busy} className="min-h-11 rounded-xl bg-[var(--accent)] px-4 text-sm font-semibold text-white disabled:opacity-50">Publish update</button><p className="text-xs text-[var(--muted)]">This records match information only. The app does not decide breaches or penalties.</p></form>}
      {selected && <section className="mt-5 rounded-2xl border border-[var(--line)] bg-[var(--surface)] p-5"><h2 className="font-bold text-[var(--ink)]">Result and scorecard</h2><p className="mt-1 text-sm text-[var(--muted)]">Card status: <strong className="capitalize">{cardState}</strong>. Scorecard files are uploaded privately for authorised reviewers.</p><form onSubmit={(event) => void saveResult(event)} className="mt-4 grid gap-3 sm:grid-cols-2"><label className="text-sm font-semibold text-[var(--ink)]">Home score<input name="home_score" type="number" min="0" required defaultValue={selected.home_score ?? ''} className={field} /></label><label className="text-sm font-semibold text-[var(--ink)]">Away score<input name="away_score" type="number" min="0" required defaultValue={selected.away_score ?? ''} className={field} /></label><label className="text-sm font-semibold text-[var(--ink)] sm:col-span-2">Set results (optional JSON)<input name="set_results" placeholder='[{"home":6,"away":4}]' className={field} /></label><label className="text-sm font-semibold text-[var(--ink)] sm:col-span-2">Scorecard PDF or image (optional)<input name="scorecard" type="file" accept="application/pdf,image/jpeg,image/png,image/webp,image/heic" className={`${field} py-2`} /></label><label className="text-sm font-semibold text-[var(--ink)] sm:col-span-2">Correction note (if correcting)<input name="correction_note" maxLength={500} placeholder="Explain a correction to a previous result" className={field} /></label><button disabled={busy} className="min-h-11 rounded-xl bg-[var(--accent)] px-4 text-sm font-semibold text-white disabled:opacity-50 sm:col-span-2">Save result submission</button></form>{resultHistory.length > 0 && <div className="mt-5"><h3 className="font-semibold text-[var(--ink)]">Submission history</h3><ol className="mt-2 divide-y divide-[var(--line)]">{resultHistory.map((r) => <li key={r.id} className="py-3 text-sm"><p className="font-semibold text-[var(--ink)]">{r.home_score}–{r.away_score} · {stamp(r.submitted_at)}</p>{r.set_results && <p className="text-[var(--muted)]">Sets: {r.set_results}</p>}{r.correction_note && <p className="text-[var(--muted)]">Correction: {r.correction_note}</p>}<p className="text-xs text-[var(--muted)]">{r.scorecard_path ? <button type="button" onClick={() => void downloadCard(r.scorecard_user_id!, r.scorecard_path!)} className="font-semibold text-[var(--accent)] underline">Download private scorecard</button> : 'No scorecard attached'}</p></li>)}</ol></div>}</section>}
      <section className="mt-7 rounded-2xl border border-[var(--line)] bg-[var(--surface)] p-5"><h2 className="font-bold text-[var(--ink)]">Squad</h2><p className="mt-1 text-sm text-[var(--muted)]">Regular and emergency players in each team's squad. Being in the squad does not select anyone for this fixture.</p>
        {selected && [[selected.home_team_id, selected.home_team_name], [selected.away_team_id, selected.away_team_name]].map(([teamId, teamName]) => <div key={teamId} className="mt-4"><h3 className="font-semibold text-[var(--ink)]">{teamName}</h3>{squad.filter((m) => m.team_id === teamId).length === 0 ? <p className="mt-2 text-sm text-[var(--muted)]">No squad members recorded for this team yet.</p> : <div className="mt-2 divide-y divide-[var(--line)]">{squad.filter((m) => m.team_id === teamId).map((m) => <div key={`${m.team_id}-${m.user_id}`} className="flex flex-wrap items-center justify-between gap-3 py-2"><div><p className="font-semibold text-[var(--ink)]">{m.display_name}</p><p className="text-sm text-[var(--muted)]">{m.is_active ? (m.pool === 'emergency' ? 'Emergency pool' : 'Regular pool') : 'Left squad'}</p></div>{m.is_active ? <div className="flex flex-wrap gap-2"><select aria-label={`Pool for ${m.display_name}`} className={field} value={m.pool} disabled={busy} onChange={(e) => void changePool(m, e.target.value as 'regular' | 'emergency')}><option value="regular">Regular</option><option value="emergency">Emergency</option></select><button disabled={busy} onClick={() => void leaveSquad(m)} className="min-h-11 rounded-xl border border-[var(--line)] px-3 text-sm font-semibold text-[var(--danger)]">Leave squad</button></div> : null}</div>)}</div>}</div>)}
      </section>
      <section className="mt-7 rounded-2xl border border-[var(--line)] bg-[var(--surface)] p-5"><h2 className="font-bold text-[var(--ink)]">Select for this fixture</h2><div className="mt-3 flex flex-col gap-2 sm:flex-row"><select aria-label="Player to add" className={field} value={candidateId} onChange={(e) => { setCandidateId(e.target.value); setSelectionState(defaultSelectionFor(eligible.find((x) => x.user_id === e.target.value)?.pool)) }}><option value="">Choose a team member</option>{eligible.map((p) => <option key={p.user_id} value={p.user_id}>{p.display_name}</option>)}</select><select aria-label="Selection state" className={field} value={selectionState} onChange={(e) => setSelectionState(e.target.value as Selection)}>{selectionOptionsFor(eligible.find((x) => x.user_id === candidateId)?.pool).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select><button disabled={busy || !candidateId} onClick={() => void mutate('add_fixture_roster_player', candidateId, selectionState)} className="min-h-11 rounded-xl bg-[var(--accent)] px-4 text-sm font-semibold text-white disabled:opacity-50">Add to roster</button></div>
        <div className="mt-4 divide-y divide-[var(--line)]">{players.length === 0 ? <p className="py-4 text-sm text-[var(--muted)]">No players published for this fixture yet.</p> : players.map((p) => <div key={p.user_id} className="flex flex-wrap items-center justify-between gap-3 py-3"><div><p className="font-semibold text-[var(--ink)]">{p.display_name}</p><p className="text-sm text-[var(--muted)]">{p.availability === 'pending' ? 'Not sure / pending' : p.availability === 'in' ? 'In' : 'Out'} · Updated {stamp(p.updated_at)}</p><p className="text-xs font-semibold text-[var(--accent-deep)]">{selectionLabel(p.selection)}{p.pool === 'emergency' ? ' · emergency pool' : ''}</p><label className="mt-2 block text-xs font-semibold text-[var(--ink)]">Selection<select aria-label={`Selection for ${p.display_name}`} className={field} value={p.selection ?? 'selected'} disabled={busy} onChange={(e) => void mutate('add_fixture_roster_player', p.user_id, e.target.value as Selection)}>{selectionOptionsFor(p.pool).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label></div><button disabled={busy} onClick={() => void mutate('remove_fixture_roster_player', p.user_id)} className="min-h-11 rounded-xl border border-[var(--line)] px-3 text-sm font-semibold text-[var(--danger)]">Remove</button></div>)}</div>
      </section>
      <section className="mt-7 rounded-2xl border border-[var(--line)] bg-[var(--surface)] p-5"><h2 className="font-bold text-[var(--ink)]">Selection history</h2>{selectionHistory.length ? <ol className="mt-3 divide-y divide-[var(--line)]">{selectionHistory.map((h) => <li key={h.id} className="py-3 text-sm text-[var(--ink)]"><span className="font-semibold">{h.display_name}</span> {h.old_selection ? `${selectionLabel(h.old_selection)} → ${selectionLabel(h.new_selection)}` : `set to ${selectionLabel(h.new_selection)}`} <span className="text-[var(--muted)]">· by {h.actor_user_id === app.auth.user?.id ? 'you' : 'a club manager'} · {stamp(h.created_at)}</span></li>)}</ol> : <p className="mt-3 text-sm text-[var(--muted)]">No selection changes recorded.</p>}</section>
      <section className="mt-7 rounded-2xl border border-[var(--line)] bg-[var(--surface)] p-5"><h2 className="font-bold text-[var(--ink)]">Roster activity</h2>{activity.length ? <ol className="mt-3 divide-y divide-[var(--line)]">{activity.map((a, i) => <li key={`${a.created_at}-${i}`} className="py-3 text-sm text-[var(--ink)]"><span className="font-semibold">{a.display_name}</span> {a.action === 'added' ? 'was added' : a.action === 'removed' ? 'was removed' : `changed availability from ${a.old_availability} to ${a.new_availability}`} <span className="text-[var(--muted)]">· {stamp(a.created_at)}</span></li>)}</ol> : <p className="mt-3 text-sm text-[var(--muted)]">No roster changes recorded.</p>}</section>
    </> : <p className="mt-6 rounded-2xl border border-dashed border-[var(--line-strong)] p-6 text-sm text-[var(--muted)]">No fixtures are available to manage.</p>}
  </main>
}
function Count({ label, value }: { label: string; value: number }) { return <div className="rounded-2xl border border-[var(--line)] bg-[var(--surface)] p-4"><p className="text-2xl font-bold text-[var(--ink)]">{value ?? 0}</p><p className="text-sm text-[var(--muted)]">{label}</p></div> }

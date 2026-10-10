import { useEffect, useMemo, useState } from 'react'
import type { ProAppStore } from '@proappstore/sdk'

type Club = { id: string; name: string; slug: string; role: string }
type Season = { id: string; org_id: string; name: string; starts_on: string; ends_on: string; status: string }
type Division = { id: string; name: string; season_id: string; format: string | null }
type Venue = { id: string; org_id: string; name: string; address: string | null; map_url: string | null; notes: string | null; convenor_phone: string | null }
type Team = { id: string; name: string; division_id: string | null; division_name: string | null; season_name: string | null }
type Member = { id: string; display_name: string; role: string; user_id: string }
type Rows<T> = { rows: T[] }
type FirstClubSetup = { eligible: number; pending_org_id?: string | null; pending_club_name?: string | null }
const field = 'mt-1 min-h-11 w-full rounded-xl border border-[var(--line)] bg-[var(--surface)] px-3 text-sm text-[var(--ink)]'
const button = 'min-h-11 rounded-xl bg-[var(--accent)] px-4 text-sm font-semibold text-white disabled:opacity-50'
const id = () => crypto.randomUUID()

export default function ClubAdmin({ app }: { app: ProAppStore }) {
  const [clubs, setClubs] = useState<Club[]>([])
  const [clubId, setClubId] = useState('')
  const [seasons, setSeasons] = useState<Season[]>([])
  const [divisions, setDivisions] = useState<Division[]>([])
  const [venues, setVenues] = useState<Venue[]>([])
  const [teams, setTeams] = useState<Team[]>([])
  const [members, setMembers] = useState<Member[]>([])
  const [canCreateClub, setCanCreateClub] = useState(false)
  const [pendingClub, setPendingClub] = useState<{ id: string; name: string } | null>(null)
  const [loadingClubs, setLoadingClubs] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [inviteLink, setInviteLink] = useState('')
  const club = useMemo(() => clubs.find((item) => item.id === clubId), [clubs, clubId])

  async function loadClubs() {
    setLoadingClubs(true)
    setError('')
    try {
      const [result, eligibility] = await Promise.all([
        app.actions.call<Rows<Club>>('list_managed_clubs', {}),
        app.actions.call<Rows<FirstClubSetup>>('can_create_first_club', {}),
      ])
      const next = result.rows ?? []
      const setup = eligibility.rows?.[0]
      setClubs(next); setCanCreateClub(setup?.eligible === 1)
      setPendingClub(setup?.pending_org_id && setup.pending_club_name ? { id: setup.pending_org_id, name: setup.pending_club_name } : null)
      setClubId((current) => next.some((item) => item.id === current) ? current : next[0]?.id ?? '')
    } catch { setError('Club access could not be loaded. Sign in again or ask a club administrator for access.') }
    finally { setLoadingClubs(false) }
  }

  async function loadClubData(selectedId = clubId) {
    if (!selectedId) return
    try {
      const [s, d, v, t, m] = await Promise.all([
        app.actions.call<Rows<Season>>('list_club_seasons', { org_id: selectedId }),
        app.actions.call<Rows<Division>>('list_club_divisions', { org_id: selectedId }),
        app.actions.call<Rows<Venue>>('list_club_venues', { org_id: selectedId }),
        app.actions.call<Rows<Team>>('list_club_teams', { org_id: selectedId }),
        app.actions.call<Rows<Member>>('list_club_members', { org_id: selectedId }),
      ])
      setSeasons(s.rows ?? []); setDivisions(d.rows ?? []); setVenues(v.rows ?? []); setTeams(t.rows ?? []); setMembers(m.rows ?? [])
    } catch { setError('Club records could not be loaded for your membership.') }
  }

  useEffect(() => { void loadClubs() }, [app])
  useEffect(() => { void loadClubData(clubId) }, [clubId])

  async function runAction(name: string, values: Record<string, unknown>, success: string) {
    setBusy(true); setError(''); setMessage(''); setInviteLink('')
    try {
      await app.actions.call(name, values)
      setMessage(success)
      await loadClubData()
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'The change could not be saved.') }
    finally { setBusy(false) }
  }

  async function createClub(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget); const name = String(form.get('club_name') ?? '').trim()
    if (!name) return
    const orgId = id(); const slug = `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}-${orgId.slice(0, 6)}`
    setBusy(true); setError(''); setMessage('')
    try {
      await app.actions.call('create_club', { id: orgId, name, slug })
      await finishFirstClubSetup(orgId, name)
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'The club could not be created.') }
    finally { setBusy(false) }
  }

  async function finishFirstClubSetup(orgId: string, name: string) {
    await app.actions.call('bootstrap_club_admin', { id: id(), org_id: orgId, display_name: app.auth.user?.login ?? name })
    const managed = await app.actions.call<Rows<Club>>('list_managed_clubs', {})
    if (!(managed.rows ?? []).some((item) => item.id === orgId)) throw new Error('Administrator access could not be confirmed yet. Retry setup below.')
    setPendingClub(null)
    setMessage(`${name} is ready. You are its administrator.`)
    await loadClubs()
    setClubId(orgId)
  }

  async function resumeFirstClubSetup() {
    if (!pendingClub) return
    setBusy(true); setError(''); setMessage('')
    try { await finishFirstClubSetup(pendingClub.id, pendingClub.name) }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Administrator setup could not be completed. Retry below.') }
    finally { setBusy(false) }
  }

  async function createTeamInvite(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget); const teamId = String(form.get('team_id') ?? '')
    const token = id()
    setBusy(true); setError(''); setMessage(''); setInviteLink('')
    try {
      await app.actions.call('create_team_invite', { id: id(), team_id: teamId, invite_token: token })
      const invite = await app.invites.create({ role: 'player', group: `team:${teamId}`, metadata: { claimToken: token }, uses: 1, expiresIn: '7d' })
      setInviteLink(invite.link)
      setMessage('PAS team invite created. Share this link with the invited player; the membership is added after redemption.')
      await loadClubData()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'The invite could not be created. Check the PAS delegated invite setup for this team.')
    } finally { setBusy(false) }
  }

  return <main className="mx-auto w-full max-w-5xl px-4 py-8 sm:px-6">
    <h1 className="display-font text-3xl font-bold text-[var(--ink)]">Club administration</h1>
    <p className="mt-2 max-w-3xl text-sm leading-6 text-[var(--muted)]">Set up clubs and competition structure. Changes are checked against your club membership on the server. Player views do not include member contact details.</p>
    {error && <p className="mt-5 rounded-xl bg-[var(--danger)]/10 p-4 text-sm text-[var(--danger)]" role="alert">{error}</p>}
    {message && <p className="mt-5 rounded-xl bg-[var(--mint-soft)] p-4 text-sm text-[var(--mint-deep)]" role="status">{message}</p>}
    {loadingClubs && <p className="mt-7 text-sm text-[var(--muted)]" role="status">Loading club access…</p>}
    {inviteLink && <div className="mt-3 rounded-xl border border-[var(--line)] bg-[var(--surface)] p-4 text-sm"><label htmlFor="invite-link" className="font-semibold text-[var(--ink)]">PAS invitation link</label><input id="invite-link" readOnly value={inviteLink} className={field} onFocus={(event) => event.currentTarget.select()} /></div>}
    {!loadingClubs && canCreateClub && clubs.length === 0 && <section className="mt-7 rounded-2xl border border-[var(--line)] bg-[var(--surface)] p-5 sm:p-7"><h2 className="display-font text-2xl font-bold text-[var(--ink)]">Create your club</h2><p className="mt-2 text-sm leading-6 text-[var(--muted)]">Start your club setup. You’ll become its administrator and can add seasons, teams and venues next.</p><form onSubmit={(event) => void createClub(event)} className="mt-4 flex flex-col gap-3 sm:flex-row"><input aria-label="Club name" name="club_name" required maxLength={100} placeholder="Club name" className={field} /><button aria-label="Create your club" className={button} disabled={busy}>{busy ? 'Creating…' : 'Create your club'}</button></form></section>}
    {!loadingClubs && pendingClub && clubs.length === 0 && <section className="mt-7 rounded-2xl border border-[var(--line)] bg-[var(--surface)] p-5 sm:p-7"><h2 className="display-font text-2xl font-bold text-[var(--ink)]">Finish setting up {pendingClub.name}</h2><p className="mt-2 text-sm leading-6 text-[var(--muted)]">The club was created, but administrator access still needs to be set up. Resume setup to finish without creating another club.</p><button type="button" className={`${button} mt-4`} disabled={busy} onClick={() => void resumeFirstClubSetup()}>{busy ? 'Setting up…' : 'Resume club setup'}</button></section>}
    {!loadingClubs && clubs.length > 0 && <label className="mt-7 block max-w-xl text-sm font-semibold text-[var(--ink)]">Club<select className={field} value={clubId} onChange={(event) => setClubId(event.target.value)}>{clubs.map((item) => <option key={item.id} value={item.id}>{item.name} · {item.role}</option>)}</select></label>}
    {!loadingClubs && !clubs.length && !canCreateClub && <p className="mt-7 rounded-2xl border border-dashed border-[var(--line-strong)] p-6 text-sm text-[var(--muted)]">You don’t have club administration access yet. Ask a club administrator to add you as a manager.</p>}
    {!loadingClubs && club && <>
      <section className="mt-7 grid gap-4 md:grid-cols-2">
        <form onSubmit={(event) => { event.preventDefault(); const f = new FormData(event.currentTarget); void runAction('create_season', { id: id(), org_id: clubId, name: String(f.get('name')), starts_on: String(f.get('starts_on')), ends_on: String(f.get('ends_on')), status: 'upcoming' }, 'Season created.') }} className="rounded-2xl border border-[var(--line)] bg-[var(--surface)] p-5"><h2 className="font-bold text-[var(--ink)]">Season</h2><input aria-label="Season name" name="name" required placeholder="Season name" className={field} /><div className="mt-2 grid grid-cols-2 gap-2"><input aria-label="Season starts on" type="date" name="starts_on" required className={field} /><input aria-label="Season ends on" type="date" name="ends_on" required className={field} /></div><button className={`${button} mt-3`} disabled={busy}>Add season</button></form>
        <form onSubmit={(event) => { event.preventDefault(); const f = new FormData(event.currentTarget); void runAction('create_venue', { id: id(), org_id: clubId, name: String(f.get('name')), address: String(f.get('address')), map_url: String(f.get('map_url')), notes: String(f.get('notes')), convenor_phone: String(f.get('convenor_phone')) }, 'Venue created.') }} className="rounded-2xl border border-[var(--line)] bg-[var(--surface)] p-5"><h2 className="font-bold text-[var(--ink)]">Venue</h2><input aria-label="Venue name" name="name" required placeholder="Venue name" className={field} /><input aria-label="Venue address" name="address" placeholder="Address" className={field} /><input aria-label="Venue map link" name="map_url" type="url" placeholder="Map link (optional)" className={field} /><input aria-label="Venue access and parking notes" name="notes" placeholder="Access or parking notes (optional)" className={field} /><input aria-label="Private convenor phone" name="convenor_phone" type="tel" placeholder="Convenor phone (private to managers)" className={field} /><button className={`${button} mt-3`} disabled={busy}>Add venue</button></form>
        <form onSubmit={(event) => { event.preventDefault(); const f = new FormData(event.currentTarget); void runAction('create_division', { id: id(), season_id: String(f.get('season_id')), name: String(f.get('name')), format: String(f.get('format')) }, 'Division created.') }} className="rounded-2xl border border-[var(--line)] bg-[var(--surface)] p-5"><h2 className="font-bold text-[var(--ink)]">Division</h2><select aria-label="Division season" required name="season_id" className={field}><option value="">Choose a season</option>{seasons.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select><input aria-label="Division name" name="name" required placeholder="Division name" className={field} /><input aria-label="Division format" name="format" placeholder="Format (optional)" className={field} /><button className={`${button} mt-3`} disabled={busy || !seasons.length}>Add division</button></form>
        <form onSubmit={(event) => { event.preventDefault(); const f = new FormData(event.currentTarget); void runAction('create_team', { id: id(), org_id: clubId, division_id: String(f.get('division_id')), name: String(f.get('name')), colour: String(f.get('colour')) }, 'Team created.') }} className="rounded-2xl border border-[var(--line)] bg-[var(--surface)] p-5"><h2 className="font-bold text-[var(--ink)]">Team</h2><select aria-label="Team division" required name="division_id" className={field}><option value="">Choose a division</option>{divisions.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select><input aria-label="Team name" name="name" required placeholder="Team name" className={field} /><input aria-label="Team colour" name="colour" placeholder="Colour (optional)" className={field} /><button className={`${button} mt-3`} disabled={busy || !divisions.length}>Add team</button></form>
      </section>
      <section className="mt-8 rounded-2xl border border-[var(--line)] bg-[var(--surface)] p-5"><h2 className="text-lg font-bold text-[var(--ink)]">Invite a team member</h2><p className="mt-1 text-sm text-[var(--muted)]">Creates a one use PAS invitation. Players can see fixtures for their accepted team memberships; this screen does not show private contacts.</p><form onSubmit={(event) => void createTeamInvite(event)} className="mt-3 flex flex-col gap-3 sm:flex-row"><select aria-label="Invite team" required name="team_id" className={field}><option value="">Choose a team</option>{teams.map((item) => <option key={item.id} value={item.id}>{item.name}{item.division_name ? ` · ${item.division_name}` : ''}</option>)}</select><button className={button} disabled={busy || !teams.length}>Create PAS invite</button></form><p className="mt-3 text-xs leading-5 text-[var(--muted)]">PAS requires an app team administrator to enable delegated invites for the player role and grant the manager access to this team's group. Ask your PAS app administrator if invite creation is denied.</p></section>
      <section className="mt-8 grid gap-4 md:grid-cols-2">
        <RecordList title="Seasons" rows={seasons.map((x) => `${x.name} · ${x.starts_on} to ${x.ends_on}`)} empty="No seasons yet." />
        <RecordList title="Divisions" rows={divisions.map((x) => `${x.name}${x.format ? ` · ${x.format}` : ''}`)} empty="No divisions yet." />
        <section className="rounded-2xl border border-[var(--line)] bg-[var(--surface)] p-5"><h2 className="font-bold text-[var(--ink)]">Venue directory</h2><p className="mt-1 text-sm text-[var(--muted)]">Convenor phone numbers are private to club managers and administrators.</p>{venues.length ? <div className="mt-3 divide-y divide-[var(--line)]">{venues.map((venue) => <form key={venue.id} onSubmit={(event) => { event.preventDefault(); const f = new FormData(event.currentTarget); void runAction('update_venue', { venue_id: venue.id, org_id: clubId, name: String(f.get('name')), address: String(f.get('address')), map_url: String(f.get('map_url')), notes: String(f.get('notes')), convenor_phone: String(f.get('convenor_phone')) }, 'Venue updated. Linked fixtures will show the latest details.') }} className="grid gap-2 py-4 sm:grid-cols-2"><input aria-label={`${venue.name} name`} name="name" required defaultValue={venue.name} className={field} /><input aria-label={`${venue.name} address`} name="address" defaultValue={venue.address ?? ''} placeholder="Address" className={field} /><input aria-label={`${venue.name} map link`} name="map_url" type="url" defaultValue={venue.map_url ?? ''} placeholder="Map link" className={field} /><input aria-label={`${venue.name} access notes`} name="notes" defaultValue={venue.notes ?? ''} placeholder="Access and parking notes" className={field} /><input aria-label={`${venue.name} private convenor phone`} name="convenor_phone" type="tel" defaultValue={venue.convenor_phone ?? ''} placeholder="Private convenor phone" className={field} /><button className={button} disabled={busy}>Save venue</button></form>)}</div> : <p className="mt-3 text-sm text-[var(--muted)]">No venues yet.</p>}</section>
        <RecordList title="Teams" rows={teams.map((x) => `${x.name}${x.division_name ? ` · ${x.division_name}` : ''}`)} empty="No teams yet." />
        <RecordList title="Club managers and administrators" rows={members.filter((x) => ['admin','manager'].includes(x.role)).map((x) => `${x.display_name} · ${x.role}`)} empty="No managers listed." />
      </section>
    </>}
  </main>
}

function RecordList({ title, rows, empty }: { title: string; rows: string[]; empty: string }) { return <section className="rounded-2xl border border-[var(--line)] bg-[var(--surface)] p-5"><h2 className="font-bold text-[var(--ink)]">{title}</h2>{rows.length ? <ul className="mt-3 divide-y divide-[var(--line)] text-sm text-[var(--muted)]">{rows.map((row, i) => <li key={`${i}-${row}`} className="py-2">{row}</li>)}</ul> : <p className="mt-3 text-sm text-[var(--muted)]">{empty}</p>}</section> }

import { useEffect, useMemo, useState } from 'react'
import type { ProAppStore } from '@proappstore/sdk'
import { MCP_CATALOG } from '../generated/mcpCatalog'
import { outcomeOf, recordAudit } from './auditTrail'
import { CONTACT_VISIBILITY_NOTICE } from '../contactCopy'

type Club = { id: string; name: string; slug: string; role: string }
type Season = { id: string; org_id: string; name: string; starts_on: string; ends_on: string; status: string }
type Division = { id: string; name: string; season_id: string; format: string | null }
type Venue = { id: string; org_id: string; name: string; address: string | null; map_url: string | null; notes: string | null; shared?: number | null }
type ContactDetail = { id: string; subject_type: 'person' | 'team' | 'venue' | 'club'; subject_id: string; label: string; kind: 'phone' | 'email' | 'postal' | 'other'; value: string; updated_at: number }
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
  const [contacts, setContacts] = useState<ContactDetail[]>([])
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
      const [s, d, v, t, m, c] = await Promise.all([
        app.actions.call<Rows<Season>>('list_club_seasons', { org_id: selectedId }),
        app.actions.call<Rows<Division>>('list_club_divisions', { org_id: selectedId }),
        app.actions.call<Rows<Venue>>('list_club_venues', { org_id: selectedId }),
        app.actions.call<Rows<Team>>('list_club_teams', { org_id: selectedId }),
        app.actions.call<Rows<Member>>('list_club_members', { org_id: selectedId }),
        app.actions.call<Rows<ContactDetail>>('list_contact_details', { org_id: selectedId }),
      ])
      setSeasons(s.rows ?? []); setDivisions(d.rows ?? []); setVenues(v.rows ?? []); setTeams(t.rows ?? []); setMembers(m.rows ?? []); setContacts(c.rows ?? [])
    } catch { setError('Club records could not be loaded for your membership.') }
  }

  useEffect(() => { void loadClubs() }, [app])
  useEffect(() => { void loadClubData(clubId) }, [clubId])

  async function runAction(name: string, values: Record<string, unknown>, success: string) {
    setBusy(true); setError(''); setMessage(''); setInviteLink('')
    const targetId = String(values.id ?? values.venue_id ?? clubId)
    try {
      const result = await app.actions.call(name, values)
      const outcome = outcomeOf(result)
      const audited = await recordAudit(app, { orgId: clubId, action: name, targetType: 'club_record', targetId, outcome })
      // A refused write changed no rows: report it as not saved rather than as success.
      if (outcome === 'refused') setError('The change was not saved. Check the details and your club role, then try again.')
      else setMessage(audited ? success : `${success} The audit record could not be written.`)
      await loadClubData()
    } catch (reason) {
      await recordAudit(app, { orgId: clubId, action: name, targetType: 'club_record', targetId, outcome: 'refused' })
      setError(reason instanceof Error ? reason.message : 'The change could not be saved.')
    }
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
    await recordAudit(app, { orgId, action: 'bootstrap_club_admin', targetType: 'club_record', targetId: orgId, outcome: 'succeeded' })
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
      const inviteId = id()
      const result = await app.actions.call('create_team_invite', { id: inviteId, team_id: teamId, invite_token: token })
      const outcome = outcomeOf(result)
      await recordAudit(app, { orgId: clubId, action: 'create_team_invite', targetType: 'team_invite', targetId: inviteId, outcome })
      // No pending membership was written, so an invite link for it would never be accepted.
      if (outcome === 'refused') throw new Error('The team membership was not created.')
      // The invite carries no account role; redeeming it creates the club and team membership.
      const invite = await app.invites.create({ group: `team:${teamId}`, metadata: { claimToken: token }, uses: 1, expiresIn: '7d' })
      setInviteLink(`${window.location.origin}/join/${invite.code}`)
      setMessage('Invite link created. Share it with the player; they join the team when they open it.')
      await loadClubData()
    } catch {
      setError('The invite link could not be created. Check that the team is still active, then try again.')
    } finally { setBusy(false) }
  }

  return <main className="mx-auto w-full max-w-5xl px-4 py-8 sm:px-6">
    <h1 className="display-font text-3xl font-bold text-[var(--ink)]">Club administration</h1>
    <p className="mt-2 max-w-3xl text-sm leading-6 text-[var(--muted)]">Set up clubs and competition structure. Changes are checked against your club membership on the server. Player views do not include member contact details.</p>
    {error && <p className="mt-5 rounded-xl bg-[var(--danger)]/10 p-4 text-sm text-[var(--danger)]" role="alert">{error}</p>}
    {message && <p className="mt-5 rounded-xl bg-[var(--mint-soft)] p-4 text-sm text-[var(--mint-deep)]" role="status">{message}</p>}
    {loadingClubs && <p className="mt-7 text-sm text-[var(--muted)]" role="status">Loading club access…</p>}
    {inviteLink && <div className="mt-3 rounded-xl border border-[var(--line)] bg-[var(--surface)] p-4 text-sm"><label htmlFor="invite-link" className="font-semibold text-[var(--ink)]">Invite link</label><input id="invite-link" readOnly value={inviteLink} className={field} onFocus={(event) => event.currentTarget.select()} /></div>}
    {!loadingClubs && canCreateClub && clubs.length === 0 && <section className="mt-7 rounded-2xl border border-[var(--line)] bg-[var(--surface)] p-5 sm:p-7"><h2 className="display-font text-2xl font-bold text-[var(--ink)]">Create your club</h2><p className="mt-2 text-sm leading-6 text-[var(--muted)]">Start your club setup. You’ll become its administrator and can add seasons, teams and venues next.</p><form onSubmit={(event) => void createClub(event)} className="mt-4 flex flex-col gap-3 sm:flex-row"><input aria-label="Club name" name="club_name" required maxLength={100} placeholder="Club name" className={field} /><button aria-label="Create your club" className={button} disabled={busy}>{busy ? 'Creating…' : 'Create your club'}</button></form></section>}
    {!loadingClubs && pendingClub && clubs.length === 0 && <section className="mt-7 rounded-2xl border border-[var(--line)] bg-[var(--surface)] p-5 sm:p-7"><h2 className="display-font text-2xl font-bold text-[var(--ink)]">Finish setting up {pendingClub.name}</h2><p className="mt-2 text-sm leading-6 text-[var(--muted)]">The club was created, but administrator access still needs to be set up. Resume setup to finish without creating another club.</p><button type="button" className={`${button} mt-4`} disabled={busy} onClick={() => void resumeFirstClubSetup()}>{busy ? 'Setting up…' : 'Resume club setup'}</button></section>}
    {!loadingClubs && clubs.length > 0 && <label className="mt-7 block max-w-xl text-sm font-semibold text-[var(--ink)]">Club<select className={field} value={clubId} onChange={(event) => setClubId(event.target.value)}>{clubs.map((item) => <option key={item.id} value={item.id}>{item.name} · {item.role}</option>)}</select></label>}
    {!loadingClubs && !clubs.length && !canCreateClub && <p className="mt-7 rounded-2xl border border-dashed border-[var(--line-strong)] p-6 text-sm text-[var(--muted)]">You don’t have club administration access yet. Ask a club administrator to add you as a manager.</p>}
    {!loadingClubs && club && <>
      <section className="mt-7 grid gap-4 md:grid-cols-2">
        <form onSubmit={(event) => { event.preventDefault(); const f = new FormData(event.currentTarget); void runAction('create_season', { id: id(), org_id: clubId, name: String(f.get('name')), starts_on: String(f.get('starts_on')), ends_on: String(f.get('ends_on')), status: 'upcoming' }, 'Season created.') }} className="rounded-2xl border border-[var(--line)] bg-[var(--surface)] p-5"><h2 className="font-bold text-[var(--ink)]">Season</h2><input aria-label="Season name" name="name" required placeholder="Season name" className={field} /><div className="mt-2 grid grid-cols-2 gap-2"><input aria-label="Season starts on" type="date" name="starts_on" required className={field} /><input aria-label="Season ends on" type="date" name="ends_on" required className={field} /></div><button className={`${button} mt-3`} disabled={busy}>Add season</button></form>
        <form onSubmit={(event) => { event.preventDefault(); const f = new FormData(event.currentTarget); void runAction('create_venue', { id: id(), org_id: clubId, name: String(f.get('name')), address: String(f.get('address')), map_url: String(f.get('map_url')), notes: String(f.get('notes')) }, 'Venue created.') }} className="rounded-2xl border border-[var(--line)] bg-[var(--surface)] p-5"><h2 className="font-bold text-[var(--ink)]">Venue</h2><input aria-label="Venue name" name="name" required placeholder="Venue name" className={field} /><input aria-label="Venue address" name="address" placeholder="Address" className={field} /><input aria-label="Venue map link" name="map_url" type="url" placeholder="Map link (optional)" className={field} /><input aria-label="Venue access and parking notes" name="notes" placeholder="Access or parking notes (optional)" className={field} /><button className={`${button} mt-3`} disabled={busy}>Add venue</button></form>
        <form onSubmit={(event) => { event.preventDefault(); const f = new FormData(event.currentTarget); void runAction('create_division', { id: id(), season_id: String(f.get('season_id')), name: String(f.get('name')), format: String(f.get('format')) }, 'Division created.') }} className="rounded-2xl border border-[var(--line)] bg-[var(--surface)] p-5"><h2 className="font-bold text-[var(--ink)]">Division</h2><select aria-label="Division season" required name="season_id" className={field}><option value="">Choose a season</option>{seasons.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select><input aria-label="Division name" name="name" required placeholder="Division name" className={field} /><input aria-label="Division format" name="format" placeholder="Format (optional)" className={field} /><button className={`${button} mt-3`} disabled={busy || !seasons.length}>Add division</button></form>
        <form onSubmit={(event) => { event.preventDefault(); const f = new FormData(event.currentTarget); void runAction('create_team', { id: id(), org_id: clubId, division_id: String(f.get('division_id')), name: String(f.get('name')), colour: String(f.get('colour')) }, 'Team created.') }} className="rounded-2xl border border-[var(--line)] bg-[var(--surface)] p-5"><h2 className="font-bold text-[var(--ink)]">Team</h2><select aria-label="Team division" required name="division_id" className={field}><option value="">Choose a division</option>{divisions.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select><input aria-label="Team name" name="name" required placeholder="Team name" className={field} /><input aria-label="Team colour" name="colour" placeholder="Colour (optional)" className={field} /><button className={`${button} mt-3`} disabled={busy || !divisions.length}>Add team</button></form>
      </section>
      <section className="mt-8 rounded-2xl border border-[var(--line)] bg-[var(--surface)] p-5"><h2 className="text-lg font-bold text-[var(--ink)]">Invite a team member</h2><p className="mt-1 text-sm text-[var(--muted)]">Creates an invite link that works once and expires after 7 days. Players see fixtures for their team once they join; this screen does not show private contacts.</p><form onSubmit={(event) => void createTeamInvite(event)} className="mt-3 flex flex-col gap-3 sm:flex-row"><select aria-label="Invite team" required name="team_id" className={field}><option value="">Choose a team</option>{teams.map((item) => <option key={item.id} value={item.id}>{item.name}{item.division_name ? ` · ${item.division_name}` : ''}</option>)}</select><button className={button} disabled={busy || !teams.length}>Create invite</button></form><p className="mt-3 text-xs leading-5 text-[var(--muted)]">Share the link only with the player it is for. It can be used once, and if it expires you can create a new one.</p></section>
      <section className="mt-8 grid gap-4 md:grid-cols-2">
        <RecordList title="Seasons" rows={seasons.map((x) => `${x.name} · ${x.starts_on} to ${x.ends_on}`)} empty="No seasons yet." />
        <RecordList title="Divisions" rows={divisions.map((x) => `${x.name}${x.format ? ` · ${x.format}` : ''}`)} empty="No divisions yet." />
        <section className="rounded-2xl border border-[var(--line)] bg-[var(--surface)] p-5"><h2 className="font-bold text-[var(--ink)]">Venue directory</h2><p className="mt-1 text-sm text-[var(--muted)]">Venue records hold public access details only. Contact details are kept separately below.</p>{venues.length ? <div className="mt-3 divide-y divide-[var(--line)]">{venues.map((venue) => <form key={venue.id} onSubmit={(event) => { event.preventDefault(); const f = new FormData(event.currentTarget); void runAction('update_venue', { venue_id: venue.id, org_id: clubId, name: String(f.get('name')), address: String(f.get('address')), map_url: String(f.get('map_url')), notes: String(f.get('notes')) }, 'Venue updated. Linked fixtures will show the latest details.') }} className="grid gap-2 py-4 sm:grid-cols-2"><input aria-label={`${venue.name} name`} name="name" required defaultValue={venue.name} className={field} /><input aria-label={`${venue.name} address`} name="address" defaultValue={venue.address ?? ''} placeholder="Address" className={field} /><input aria-label={`${venue.name} map link`} name="map_url" type="url" defaultValue={venue.map_url ?? ''} placeholder="Map link" className={field} /><input aria-label={`${venue.name} access notes`} name="notes" defaultValue={venue.notes ?? ''} placeholder="Access and parking notes" className={field} /><label className="flex items-center gap-2 text-sm font-semibold text-[var(--ink)] sm:col-span-2"><input type="checkbox" aria-label={`${venue.name} shared with other clubs`} checked={venue.shared === 1} disabled={busy} onChange={(event) => void runAction('set_venue_shared', { venue_id: venue.id, org_id: clubId, shared: event.target.checked ? 1 : 0 }, event.target.checked ? 'Venue shared. Other clubs can now schedule fixtures here; contact details stay private.' : 'Venue no longer shared with other clubs.')} />Shared with other clubs</label><button className={button} disabled={busy}>Save venue</button></form>)}</div> : <p className="mt-3 text-sm text-[var(--muted)]">No venues yet.</p>}</section>
        <section className="mt-8 rounded-2xl border border-[var(--line)] bg-[var(--surface)] p-5"><h2 className="font-bold text-[var(--ink)]">Contact details</h2><p className="mt-1 text-sm font-semibold text-[var(--accent-deep)]">{CONTACT_VISIBILITY_NOTICE}</p>
          <form onSubmit={(event) => { event.preventDefault(); const f = new FormData(event.currentTarget); const [subjectType, subjectId] = String(f.get('subject')).split(':'); void runAction('set_contact_detail', { id: id(), org_id: clubId, subject_type: subjectType, subject_id: subjectId, label: String(f.get('label')), kind: String(f.get('kind')), value: String(f.get('value')) }, 'Contact detail saved. Only club managers and administrators can see it.') }} className="mt-3 grid gap-2 sm:grid-cols-2">
            <label className="text-sm font-semibold text-[var(--ink)]">Subject<select name="subject" className={field}><option value={`club:${clubId}`}>Club</option>{venues.map((venue) => <option key={venue.id} value={`venue:${venue.id}`}>Venue · {venue.name}</option>)}{teams.map((team) => <option key={team.id} value={`team:${team.id}`}>Team · {team.name}</option>)}</select></label>
            <label className="text-sm font-semibold text-[var(--ink)]">Label<input name="label" required maxLength={60} placeholder="For example Convenor" className={field} /></label>
            <label className="text-sm font-semibold text-[var(--ink)]">Type<select name="kind" className={field}><option value="phone">Phone</option><option value="email">Email</option><option value="postal">Postal address</option><option value="other">Other</option></select></label>
            <label className="text-sm font-semibold text-[var(--ink)]">Value<input name="value" required maxLength={200} className={field} /></label>
            <button className={`${button} sm:col-span-2`} disabled={busy}>Save contact detail</button>
          </form>
          {contacts.length ? <ul className="mt-4 divide-y divide-[var(--line)] text-sm">{contacts.map((contact) => <li key={contact.id} className="flex flex-wrap items-center justify-between gap-2 py-3"><span className="text-[var(--ink)]">{contactSubjectName(contact)} · {contact.label} · {contact.kind}: {contact.value}</span><button onClick={() => void runAction('delete_contact_detail', { id: contact.id, org_id: clubId }, 'Contact detail removed.')} disabled={busy} className="min-h-11 rounded-xl border border-[var(--line)] px-3 font-semibold text-[var(--danger)]">Remove</button></li>)}</ul> : <p className="mt-4 text-sm text-[var(--muted)]">No contact details saved.</p>}
        </section>
        <RecordList title="Teams" rows={teams.map((x) => `${x.name}${x.division_name ? ` · ${x.division_name}` : ''}`)} empty="No teams yet." />
        <RecordList title="Club managers and administrators" rows={members.filter((x) => ['admin', 'convenor', 'manager'].includes(x.role)).map((x) => `${x.display_name} · ${x.role}`)} empty="No managers listed." />
      </section>
    </>}
    <details className="mt-8 rounded-2xl border border-[var(--line)] bg-[var(--surface)] p-5">
      <summary className="cursor-pointer font-bold text-[var(--ink)]">Integration actions ({MCP_CATALOG.length})</summary>
      <p className="mt-3 text-sm text-[var(--muted)]">Actions available to connected club systems. Each call is checked against the caller’s club membership on the server.</p>
      <ul className="mt-3 divide-y divide-[var(--line)] text-sm">{MCP_CATALOG.map((action) => <li key={action.name} className="py-3"><code className="font-semibold text-[var(--ink)]">{action.name}</code><p className="mt-1 text-[var(--muted)]">{action.description}</p><p className="mt-1 text-xs text-[var(--muted)]">Roles: {action.roles.join(', ') || action.access} · {action.idempotency}{action.audit ? ' · audited' : ''}</p></li>)}</ul>
    </details>
  </main>
}

function contactSubjectName(contact: ContactDetail) { return contact.subject_type === 'club' ? 'Club' : contact.subject_type === 'venue' ? 'Venue' : contact.subject_type === 'team' ? 'Team' : 'Person' }

function RecordList({ title, rows, empty }: { title: string; rows: string[]; empty: string }) { return <section className="rounded-2xl border border-[var(--line)] bg-[var(--surface)] p-5"><h2 className="font-bold text-[var(--ink)]">{title}</h2>{rows.length ? <ul className="mt-3 divide-y divide-[var(--line)] text-sm text-[var(--muted)]">{rows.map((row, i) => <li key={`${i}-${row}`} className="py-2">{row}</li>)}</ul> : <p className="mt-3 text-sm text-[var(--muted)]">{empty}</p>}</section> }

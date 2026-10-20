import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { initPro, PageHeader, ProShell, type NavItem, useAuth } from '@proappstore/sdk'
import ClubAdmin from './pages/ClubAdmin'
import { fixtureArrivalLabel, fixtureListStart, fixtureStartLabel } from './fixtureTime'
import RosterAdmin from './pages/RosterAdmin'
import FixtureImport from './pages/FixtureImport'
import FixtureList from './pages/FixtureList'
import { completedScoreLabel } from './fixtureResult'
import DocumentLibrary from './pages/DocumentLibrary'
import ImportReview from './pages/ImportReview'
import { outcomeOf } from './pages/auditTrail'
import { applyPageMeta, SIGN_IN_META, signedInMeta, signedInTitle } from './seo'
import { reportPageLoad, reportPageView, routeName } from './telemetry/pages'
import { PageErrorBoundary } from './telemetry/boundary'

const app = initPro({ appId: 'tennis-clubs' })
export const NAV: NavItem[] = [{ label: 'Comps', href: '/', title: 'Comps — Tennis Clubs' }, { label: 'Fixtures', href: '/fixtures', title: 'Upcoming fixtures — Tennis Clubs' }, { label: 'Import', href: '/fixture-import', title: 'Import fixtures — Tennis Clubs' }, { label: 'Fixture rosters', href: '/rosters', title: 'Fixture rosters — Tennis Clubs' }, { label: 'Documents', href: '/documents', title: 'Documents — Tennis Clubs' }, { label: 'Import review', href: '/import-review', title: 'Import review — Tennis Clubs' }, { label: 'Club setup', href: '/admin', title: 'Club administration — Tennis Clubs' }]
type Availability = 'in' | 'out' | 'pending'
type Fixture = { id: string; starts_at: string; time_status: string | null; arrival_at: string | null; round_label: string | null; status: string; home_score: number | null; away_score: number | null; status_updated_at: number | null; match_notice: string | null; home_team_name: string; away_team_name: string; member_side: 'home' | 'away' | null; opponent_name: string | null; is_external_opponent: number | null; division_name: string | null; venue_name: string | null; venue_address: string | null; map_url: string | null; venue_notes: string | null; my_availability: Availability | null }
type RosterPlayer = { user_id: string; display_name: string; availability: Availability; selection?: string | null }

const selectionLabelFor = (value: string) => ({ pending: 'Selection pending', unavailable: 'Unavailable', emergency_call_up: 'Emergency call-up' } as Record<string, string>)[value] ?? value
const availabilityLabel = (value: Availability | null) => value === 'in' ? 'Playing' : value === 'out' ? 'Unavailable' : 'Reply needed'
const statusLabel = (value: string) => ({ scheduled: 'Scheduled', washout: 'Washout', heat_out: 'Heat-out', forfeit: 'Forfeit', complete: 'Complete' }[value] ?? value)
const stamp = (value: number) => new Intl.DateTimeFormat('en-AU', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value < 1e12 ? value * 1000 : value))

// A render failure on any page is reported as page.error and replaced by a plain fallback (issue #30).
export default function App() {
  return <PageErrorBoundary logs={app.logs} route={() => routeName(window.location.pathname, NAV)}><AppRoutes /></PageErrorBoundary>
}

function AppRoutes() {
  const { user, loading, signOut } = useAuth(app)
  if (loading) return <main className="mx-auto max-w-xl px-4 py-16 text-center text-sm text-[var(--muted)]" role="status">Checking your sign-in…</main>
  if (!user) return <GoogleSignIn />

  return <AuthenticatedApp user={user} signOut={signOut} />
}

function AuthenticatedApp({ user, signOut }: { user: { id: string; login: string }; signOut: () => void }) {
  const path = window.location.pathname
  const renderStartedAt = performance.now()
  // Page telemetry: load timing once per document, and how long each screen took to render (see telemetry/pages.ts).
  useEffect(() => { reportPageLoad(app.logs, routeName(path, NAV)); reportPageView(app.logs, routeName(path, NAV), renderStartedAt) }, [path])
  // Signed-in views are excluded from search and point their canonical link at the site root (see seo.ts).
  useEffect(() => applyPageMeta(signedInMeta(signedInTitle(path, NAV))), [path])
  const page = path === '/admin' ? <ClubAdmin app={app} /> : path === '/fixture-import' ? <FixtureImport app={app} /> : path === '/fixtures' ? <FixtureList app={app} /> : path === '/rosters' ? <RosterAdmin app={app} /> : path === '/documents' ? <DocumentLibrary app={app} /> : path === '/import-review' ? <ImportReview app={app} /> : path.startsWith('/join/') ? <TeamInviteAcceptance app={app} code={decodeURIComponent(path.slice('/join/'.length))} /> : <Comps user={user} onSignOut={signOut} />
  return <ProShell
    app={app}
    appName="Tennis Clubs"
    nav={NAV}
    hideFooter
    renderTopbar={({ appName, nav, profileMenu, textSizeToggle }) => (
      <header className="border-b border-[var(--line)] bg-[var(--surface)] px-4 py-3 sm:px-6">
        {/* The first Tab stop: keyboard and screen-reader users can skip the navigation and go straight to the page. */}
        <a href="#main-content" className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-2 focus:z-50 focus:rounded-lg focus:bg-[var(--surface)] focus:px-4 focus:py-2 focus:text-sm focus:font-semibold focus:text-[var(--ink)]">Skip to main content</a>
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-3">
          <a href="/" className="inline-flex min-h-11 shrink-0 items-center gap-2 rounded-xl text-lg font-bold text-[var(--ink)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]" aria-label="Tennis Clubs home">
            <span aria-hidden="true" className="text-2xl">🎾</span>
            <span>{appName}</span>
          </a>
          {nav}
          <div className="ml-auto flex min-h-11 items-center gap-2">{textSizeToggle}{profileMenu}</div>
        </div>
      </header>
    )}
  ><div id="main-content" tabIndex={-1} className="outline-none">{page}</div></ProShell>
}

function GoogleSignIn() {
  useEffect(() => { document.title = SIGN_IN_META.title; applyPageMeta(SIGN_IN_META) }, [])
  useEffect(() => { reportPageLoad(app.logs, 'sign_in') }, [])
  return <main className="mx-auto max-w-xl px-4 py-16"><section className="rounded-3xl border border-[var(--line)] bg-[var(--surface)] p-7 text-center shadow-sm sm:p-10"><span className="text-4xl" aria-hidden>🎾</span><h1 className="display-font mt-4 text-3xl font-bold text-[var(--ink)]">Your club, in your pocket</h1><p className="mt-3 text-sm leading-6 text-[var(--muted)]">Sign in with your Google account to see your team fixtures, roster and match-day details.</p><button onClick={() => app.auth.signIn('google')} className="mt-6 min-h-11 w-full rounded-xl bg-[var(--accent)] px-5 font-semibold text-white">Continue with Google</button></section></main>
}

function TeamInviteAcceptance({ app: inviteApp, code }: { app: typeof app; code: string }) {
  const [message, setMessage] = useState('Accepting your team invitation…')
  // The invite is single-use and StrictMode runs effects twice in development: only the first run redeems it, and its result is always shown.
  const startedFor = useRef('')
  useEffect(() => {
    if (startedFor.current === code) return
    startedFor.current = code
    void (async () => {
      try {
        const invite = await inviteApp.invites.redeem(code)
        const token = typeof invite.metadata?.claimToken === 'string' ? invite.metadata.claimToken : ''
        if (!token) { setMessage('This invite link does not include a team membership. Ask the club for a fresh link.'); return }
        const displayName = inviteApp.auth.user?.login ?? 'Team member'
        await inviteApp.actions.call('activate_invited_club_membership', { id: crypto.randomUUID(), claim_token: token, display_name: displayName })
        await inviteApp.actions.call('accept_team_invite', { claim_token: token, display_name: displayName })
        setMessage('You have joined the team. Open Club setup to view your fixtures.')
      } catch {
        setMessage('This invite link could not be accepted. It may have expired or already been used. Ask the club for a fresh link.')
      }
    })()
  }, [inviteApp, code])
  return <main className="mx-auto max-w-2xl px-4 py-12"><h1 className="display-font text-3xl font-bold text-[var(--ink)]">Team invitation</h1><p className="mt-4 rounded-2xl bg-[var(--surface)] p-5 text-sm text-[var(--ink)]" role="status">{message}</p></main>
}

export function Comps({ user, onSignOut }: { user: { id: string; login: string }; onSignOut: () => void }) {
  const [fixtures, setFixtures] = useState<Fixture[]>([])
  const [selected, setSelected] = useState<Fixture | null>(null)
  const [roster, setRoster] = useState<RosterPlayer[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!user) return
    setLoading(true); setError(null)
    try {
      const result = await app.actions.call<{ rows: Fixture[] }>('list_my_fixtures', { from: fixtureListStart(), limit: 24 })
      setFixtures(result.rows ?? [])
    } catch { setError('Your fixture list could not be loaded. Please try again.') }
    finally { setLoading(false) }
  }, [user])
  useEffect(() => { void load() }, [load])

  async function openFixture(fixture: Fixture) {
    setSelected(fixture); setRoster([])
    try { const result = await app.actions.call<{ rows: RosterPlayer[] }>('list_fixture_roster', { fixture_id: fixture.id }); setRoster(result.rows ?? []) }
    catch { setError('The roster could not be loaded. Please try again.') }
  }
  async function setAvailability(availability: Availability) {
    if (!selected) return
    setSaving(true)
    try {
      const oldAvailability = selected.my_availability ?? 'pending'
      const newAvailability = availability
      const result = await app.actions.call('set_my_fixture_availability', { fixture_id: selected.id, availability })
      // No roster row was changed, so the reply is not shown as saved.
      if (outcomeOf(result) === 'refused') { setError('Your availability was not saved. You may not be on this fixture’s roster yet.'); return }
      if (oldAvailability !== newAvailability) {
        await app.actions.call('log_my_fixture_availability_change', {
          fixture_id: selected.id,
          old_availability: oldAvailability,
          new_availability: newAvailability,
        })
      }
      setSelected({ ...selected, my_availability: availability })
      setFixtures((all) => all.map((fixture) => fixture.id === selected.id ? { ...fixture, my_availability: availability } : fixture))
      setRoster((all) => all.map((player) => player.user_id === user?.id ? { ...player, availability } : player))
    } catch { setError('Your availability was not saved. Please try again.') }
    finally { setSaving(false) }
  }
  const upcoming = fixtures.filter((fixture) => fixture.status !== 'complete')
  const pending = upcoming.filter((fixture) => !fixture.my_availability || fixture.my_availability === 'pending').length


  return <main className="container-app py-7 sm:py-10">
    <section className="rounded-3xl border border-[var(--line)] bg-[var(--accent-gradient)] p-6 shadow-[var(--shadow-card)] sm:p-8">
      <span className="inline-flex h-11 w-11 items-center justify-center rounded-2xl bg-[var(--accent-soft)] text-2xl" aria-hidden>🎾</span>
      <PageHeader title="Comps" description="Your fixtures, team roster and match-day details in one place." />
      <p className="mt-2 max-w-2xl text-sm leading-6 text-[var(--muted)]">No more scrolling across a spreadsheet. See where you are playing, who is available, and what your team needs from you.</p>
    </section>
    {error && <div role="alert" className="mt-5 flex items-center justify-between gap-4 rounded-2xl border border-[var(--danger)]/25 bg-[var(--danger)]/10 px-4 py-3 text-sm text-[var(--danger-ink)]"><span>{error}</span><button onClick={() => void load()} className="font-semibold underline">Retry</button></div>}
    <section className="mt-7 grid gap-4 sm:grid-cols-3"><Stat label="Upcoming fixtures" value={loading ? '—' : String(upcoming.length)} tone="var(--sky-soft)" /><Stat label="Replies needed" value={loading ? '—' : String(pending)} tone="var(--accent-soft)" /><Stat label="First module" value="Comps" tone="var(--mint-soft)" /></section>
    <section className="mt-8"><div className="flex items-end justify-between gap-3"><div><h2 className="display-font text-2xl font-bold text-[var(--ink)]">Your next games</h2><p className="mt-1 text-sm text-[var(--muted)]">Tap a fixture for the team list, location and your availability.</p></div><button onClick={() => void load()} className="min-h-11 rounded-xl border border-[var(--line)] bg-[var(--surface)] px-3 text-sm font-semibold text-[var(--ink)] hover:border-[var(--accent)]">Refresh</button></div>
      {loading ? <LoadingCards /> : fixtures.length === 0 ? <EmptyComps onSignOut={onSignOut} /> : <ul className="mt-4 grid list-none gap-3">{fixtures.map((fixture) => <li key={fixture.id}><FixtureCard fixture={fixture} onOpen={() => void openFixture(fixture)} /></li>)}</ul>}
    </section>
    {selected && <FixtureDetail fixture={selected} roster={roster} saving={saving} onClose={() => setSelected(null)} onAvailability={setAvailability} />}
  </main>
}

function Stat({ label, value, tone }: { label: string; value: string; tone: string }) { return <div className="rounded-2xl border border-[var(--line)] bg-[var(--surface)] p-4 shadow-sm"><div className="h-1.5 w-12 rounded-full" style={{ background: tone }} /><p className="mt-4 text-2xl font-bold text-[var(--ink)]">{value}</p><p className="mt-1 text-sm text-[var(--muted)]">{label}</p></div> }
function FixtureCard({ fixture, onOpen }: { fixture: Fixture; onOpen: () => void }) { const className = fixture.my_availability === 'in' ? 'bg-[var(--mint-soft)] text-[var(--mint-deep)]' : fixture.my_availability === 'out' ? 'bg-[var(--danger)]/10 text-[var(--danger-ink)]' : 'bg-[var(--accent-soft)] text-[var(--accent-deep)]'; return <button onClick={onOpen} aria-haspopup="dialog" className="grid w-full gap-3 rounded-2xl border border-[var(--line)] bg-[var(--surface)] p-4 text-left shadow-sm hover:border-[var(--accent)] sm:grid-cols-[10rem_1fr_auto] sm:items-center sm:p-5"><div><p className="font-semibold text-[var(--ink)]">{fixtureStartLabel(fixture)}</p>{fixtureArrivalLabel(fixture) && <p className="mt-1 text-xs text-[var(--muted)]">{fixtureArrivalLabel(fixture)}</p>}<p className="mt-1 text-xs text-[var(--muted)]">{fixture.round_label ?? fixture.division_name ?? 'Competition fixture'}</p></div><div><p className="text-base font-bold text-[var(--ink)]">{fixture.home_team_name} <span className="font-medium text-[var(--muted)]">vs</span> {fixture.away_team_name}</p>{fixture.member_side && <p className="mt-1 text-xs font-semibold text-[var(--accent-deep)]">Your team: {fixture.member_side === 'home' ? fixture.home_team_name : fixture.away_team_name}</p>}{fixture.is_external_opponent ? <p className="mt-1 text-xs font-semibold text-[var(--muted)]">Opponent (external): {fixture.opponent_name ?? fixture.away_team_name}</p> : null}<p className="mt-1 text-sm text-[var(--muted)]">{fixture.venue_name ?? 'Venue to be confirmed'}{fixture.venue_address ? ` · ${fixture.venue_address}` : ''}</p>{completedScoreLabel(fixture) && <p className="mt-1 text-base font-bold text-[var(--ink)]">Result: {completedScoreLabel(fixture)}</p>}<p className="mt-1 text-sm font-semibold text-[var(--accent-deep)]">{statusLabel(fixture.status)}{fixture.status_updated_at ? ` · Updated ${stamp(fixture.status_updated_at)}` : ''}</p>{fixture.match_notice && <p className="mt-1 text-sm text-[var(--ink)]">{fixture.match_notice}</p>}</div><span className={`w-fit rounded-full px-3 py-1.5 text-xs font-bold ${className}`}>{availabilityLabel(fixture.my_availability)}</span></button> }
function FixtureDetail({ fixture, roster, saving, onClose, onAvailability }: { fixture: Fixture; roster: RosterPlayer[]; saving: boolean; onClose: () => void; onAvailability: (value: Availability) => void }) {
  const dialog = useRef<HTMLDivElement>(null)
  // Focus moves into the dialog when it opens and returns to the fixture card that opened it when it closes.
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null
    dialog.current?.querySelector<HTMLElement>('button')?.focus()
    return () => opener?.focus()
  }, [])
  // Escape closes the dialog; Tab and Shift+Tab stay inside it while it is open.
  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape') { onClose(); return }
    if (event.key !== 'Tab' || !dialog.current) return
    const focusable = [...dialog.current.querySelectorAll<HTMLElement>('button:not([disabled]), a[href]')]
    const first = focusable[0]
    const last = focusable[focusable.length - 1]
    if (!first) return
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
  }
  return <div ref={dialog} onKeyDown={onKeyDown} className="fixed inset-0 z-50 flex items-end bg-black/30 p-0 sm:items-center sm:justify-center sm:p-6" role="dialog" aria-modal="true" aria-labelledby="fixture-dialog-title"><div className="max-h-[90dvh] w-full max-w-xl overflow-y-auto rounded-t-3xl bg-[var(--paper)] p-6 shadow-2xl sm:rounded-3xl"><div className="flex items-start justify-between gap-4"><div><p className="text-sm font-semibold text-[var(--accent)]">{fixture.round_label ?? fixture.division_name ?? 'Competition fixture'}</p><h2 id="fixture-dialog-title" className="display-font mt-1 text-3xl font-bold text-[var(--ink)]">{fixture.home_team_name} vs {fixture.away_team_name}</h2>{fixture.member_side && <p className="mt-1 text-sm font-semibold text-[var(--accent-deep)]">Your team: {fixture.member_side === 'home' ? fixture.home_team_name : fixture.away_team_name}</p>}{fixture.is_external_opponent ? <p className="mt-1 text-sm font-semibold text-[var(--muted)]">Opponent (external): {fixture.opponent_name ?? fixture.away_team_name}</p> : null}</div><button onClick={onClose} aria-label="Close fixture details" className="min-h-11 min-w-11 rounded-xl border border-[var(--line)] text-xl text-[var(--ink)]">×</button></div><dl className="mt-5 grid gap-4 rounded-2xl bg-[var(--paper-deep)] p-4 text-sm"><div><dt className="text-[var(--muted)]">When</dt><dd className="mt-1 font-semibold text-[var(--ink)]">{fixtureStartLabel(fixture)}{fixtureArrivalLabel(fixture) && <><br />{fixtureArrivalLabel(fixture)}</>}</dd></div><div><dt className="text-[var(--muted)]">Where</dt><dd className="mt-1 font-semibold text-[var(--ink)]">{fixture.venue_name ?? 'Venue to be confirmed'}<br />{fixture.venue_address}{fixture.venue_notes && <><br />{fixture.venue_notes}</>}</dd>{fixture.map_url && <a href={fixture.map_url} className="mt-1 inline-flex min-h-11 items-center font-semibold text-[var(--accent)] underline">Open map</a>}</div></dl><div className="mt-6"><p id="fixture-availability-label" className="font-semibold text-[var(--ink)]">Can you play?</p><div role="group" aria-labelledby="fixture-availability-label" className="mt-3 grid grid-cols-3 gap-2">{(['in', 'out', 'pending'] as Availability[]).map((value) => <button key={value} disabled={saving} aria-pressed={fixture.my_availability === value} onClick={() => onAvailability(value)} className={`min-h-11 rounded-xl border px-2 text-sm font-semibold ${fixture.my_availability === value ? 'border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent-deep)]' : 'border-[var(--line)] bg-[var(--surface)] text-[var(--ink)]'}`}>{value === 'in' ? 'I’m in' : value === 'out' ? 'I’m out' : 'Not sure'}</button>)}</div></div><div className="mt-7"><div className="flex items-baseline justify-between"><p className="font-semibold text-[var(--ink)]">Team roster</p><p className="text-xs text-[var(--muted)]">{roster.filter((player) => player.availability === 'in').length} playing</p></div><ul className="mt-3 list-none divide-y divide-[var(--line)] rounded-2xl border border-[var(--line)]">{roster.length === 0 ? <li className="p-4 text-sm text-[var(--muted)]">The team roster has not been published yet.</li> : roster.map((player) => <li key={player.user_id} className="flex items-center justify-between px-4 py-3"><span className="text-sm font-medium text-[var(--ink)]">{player.display_name}</span><span className="text-xs font-semibold text-[var(--muted)]">{player.selection && player.selection !== 'selected' ? `${selectionLabelFor(player.selection)} · ` : ''}{availabilityLabel(player.availability)}</span></li>)}</ul></div></div></div> }
function LoadingCards() { return <div className="mt-4 grid gap-3">{[1, 2, 3].map((key) => <div key={key} className="h-28 animate-pulse rounded-2xl bg-[var(--paper-deep)]" />)}</div> }
function EmptyComps({ onSignOut }: { onSignOut: () => void }) { return <div className="mt-4 rounded-3xl border border-dashed border-[var(--line-strong)] bg-[var(--surface)] px-6 py-12 text-center"><div className="text-4xl" aria-hidden>📅</div><h3 className="display-font mt-4 text-2xl font-bold text-[var(--ink)]">No team fixtures yet</h3><p className="mx-auto mt-2 max-w-md text-sm leading-6 text-[var(--muted)]">If you’re setting up a club, start here. If you’re joining an existing club, ask its administrator to add you to a team.</p><a href="/admin" className="mt-5 inline-flex min-h-11 items-center rounded-xl bg-[var(--accent)] px-4 font-semibold text-[var(--on-accent)]">Create your club or open club setup</a><div><button onClick={onSignOut} className="mt-3 min-h-11 px-4 text-sm font-semibold text-[var(--muted)] underline">Sign out</button></div></div> }

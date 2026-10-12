import { useEffect, useState } from 'react'
import type { ProAppStore } from '@proappstore/sdk'

type Fixture = { id: string; starts_at: string; round_label: string | null; home_team_name: string; away_team_name: string; venue_name: string | null; venue_address: string | null; member_side: 'home' | 'away' | null; opponent_name: string | null; is_external_opponent: number | null }
const dateLabel = (date: string) => new Intl.DateTimeFormat('en-AU', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(date))

export default function FixtureList({ app }: { app: ProAppStore }) {
  const [fixtures, setFixtures] = useState<Fixture[]>([])
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  useEffect(() => {
    let active = true
    app.actions.call<{ rows: Fixture[] }>('list_my_fixtures', { from: new Date().toISOString(), limit: 50 })
      .then((result) => { if (active) setFixtures(result.rows ?? []) })
      .catch(() => { if (active) setError('Fixtures could not be loaded for your teams.') })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [app])
  return <main className="mx-auto w-full max-w-5xl px-4 py-8 sm:px-6"><h1 className="display-font text-3xl font-bold text-[var(--ink)]">Upcoming fixtures</h1><p className="mt-2 text-sm text-[var(--muted)]">Fixtures for teams you belong to. Player and contact records are not shown here.</p>
    {error && <p className="mt-5 rounded-xl bg-[var(--danger)]/10 p-4 text-sm text-[var(--danger)]">{error}</p>}
    {loading ? <p className="mt-5 text-sm text-[var(--muted)]">Loading fixtures…</p> : fixtures.length === 0 ? <p className="mt-5 rounded-2xl border border-dashed border-[var(--line-strong)] p-8 text-center text-sm text-[var(--muted)]">No upcoming fixtures are available for your teams.</p> : <div className="mt-5 grid gap-3">{fixtures.map((fixture) => <article key={fixture.id} className="rounded-2xl border border-[var(--line)] bg-[var(--surface)] p-4 shadow-sm"><div className="flex flex-wrap items-baseline justify-between gap-2"><h2 className="font-bold text-[var(--ink)]">{fixture.home_team_name} <span className="font-medium text-[var(--muted)]">vs</span> {fixture.away_team_name}</h2><span className="text-xs font-semibold text-[var(--accent)]">{fixture.round_label ?? 'Fixture'}</span></div><p className="mt-2 text-sm text-[var(--muted)]">{dateLabel(fixture.starts_at)} · {fixture.venue_name ?? 'Venue to be confirmed'}{fixture.venue_address ? ` · ${fixture.venue_address}` : ''}</p><p className="mt-1 text-xs text-[var(--muted)]">{fixture.home_team_name} is home</p>{fixture.member_side && <p className="mt-1 text-xs font-semibold text-[var(--accent-deep)]">Your team: {fixture.member_side === 'home' ? fixture.home_team_name : fixture.away_team_name}</p>}{fixture.is_external_opponent ? <p className="mt-1 text-xs font-semibold text-[var(--muted)]">Opponent (external): {fixture.opponent_name ?? fixture.away_team_name}</p> : null}</article>)}</div>}
  </main>
}

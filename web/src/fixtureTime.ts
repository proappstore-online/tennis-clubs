export type TimedFixture = { starts_at: string; time_status?: string | null; arrival_at?: string | null }

const day = (value: string) => new Intl.DateTimeFormat('en-AU', { timeZone: 'Australia/Melbourne', weekday: 'short', day: 'numeric', month: 'short' }).format(new Date(value))
const clock = (value: string) => new Intl.DateTimeFormat('en-AU', { timeZone: 'Australia/Melbourne', hour: 'numeric', minute: '2-digit' }).format(new Date(value))

export function fixtureStartLabel(fixture: TimedFixture): string {
  const status = fixture.time_status ?? 'estimated'
  if (status === 'tbc') return `${day(fixture.starts_at)} · start time TBC`
  if (status === 'estimated') return `${day(fixture.starts_at)}, ${clock(fixture.starts_at)} (estimated)`
  return `${day(fixture.starts_at)}, ${clock(fixture.starts_at)}`
}

export function fixtureArrivalLabel(fixture: TimedFixture): string | null {
  return fixture.arrival_at ? `Arrival / check-in ${clock(fixture.arrival_at)}` : null
}

export function fixtureListStart(now = new Date()): string {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString()
}

// Start of a calendar day (YYYY-MM-DD, as a date input gives it) in the viewer's local time, as an ISO instant.
export function localDayStart(day: string, offsetDays = 0): string {
  const [year, month, date] = day.split('-').map(Number)
  return new Date(year, month - 1, date + offsetDays).toISOString()
}

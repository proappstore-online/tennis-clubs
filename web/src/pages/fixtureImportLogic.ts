export type FixtureOption = { kind: 'team' | 'venue' | 'external_club'; id: string; name: string; org_id: string; division_id?: string | null; season_name?: string | null; aliases?: string | null; shared?: number | null }
export type FixtureRow = { date: string; round: string; opponent: string; home_away: string; venue: string; team: string; season: string; start_time?: string; arrival_time?: string; time_status?: string; timezone?: string; source_row: number; source_date_raw: string; org_id?: string; division_id?: string | null; home_team_id?: string; away_team_id?: string; venue_id?: string; timing_status: 'confirmed' | 'estimated' | 'tbc'; starts_at: string; arrival_at: string | null; issue?: string }

export function normalizeClubName(value: string): string {
  return value.toLowerCase().replace(/ +/g, ' ').trim()
}

export function parseCsv(text: string): Record<string, string>[] {
  const lines: string[][] = []
  let row: string[] = [], field = '', quoted = false
  for (let i = 0; i < text.length; i++) {
    const char = text[i]
    if (char === '"' && quoted && text[i + 1] === '"') { field += '"'; i++ }
    else if (char === '"') quoted = !quoted
    else if (char === ',' && !quoted) { row.push(field.trim()); field = '' }
    else if ((char === '\n' || char === '\r') && !quoted) {
      if (char === '\r' && text[i + 1] === '\n') i++
      row.push(field.trim()); if (row.some(Boolean)) lines.push(row); row = []; field = ''
    } else field += char
  }
  row.push(field.trim()); if (row.some(Boolean)) lines.push(row)
  const headers = (lines.shift() ?? []).map((header) => header.trim().toLowerCase().replaceAll(' ', '_'))
  return lines.map((values) => Object.fromEntries(headers.map((header, i) => [header, values[i] ?? ''])))
}

export function normalizeDate(value: string): string | null {
  const input = value.trim()
  let year: number, month: number, day: number
  let match = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(input)
  if (match) [, year, month, day] = match.map(Number) as [number, number, number, number]
  else {
    match = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(input)
    if (!match) return null
    day = Number(match[1]); month = Number(match[2]); year = Number(match[3])
  }
  const date = new Date(Date.UTC(year!, month! - 1, day!))
  return date.getUTCFullYear() === year && date.getUTCMonth() === month! - 1 && date.getUTCDate() === day! ? `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}` : null
}

export function melbourneFixtureStart(date: string, time = '00:00'): string {
  const [year, month, day] = date.split('-').map(Number)
  const sample = new Date(Date.UTC(year!, month! - 1, day!, 12))
  const offset = new Intl.DateTimeFormat('en-AU', {
    timeZone: 'Australia/Melbourne',
    timeZoneName: 'longOffset',
  }).formatToParts(sample).find((part) => part.type === 'timeZoneName')?.value
  const match = /^GMT([+-]\d{2}:\d{2})$/.exec(offset ?? '')
  if (!match) throw new Error('Could not determine the Melbourne fixture timezone.')
  return `${date}T${time}:00${match[1]}`
}

const clockPattern = /^([01]\d|2[0-3]):[0-5]\d$/

export function fixtureTiming(row: { date: string; start_time?: string; arrival_time?: string; time_status?: string }): { timing_status: 'confirmed' | 'estimated' | 'tbc'; starts_at: string; arrival_at: string | null } {
  const start = (row.start_time ?? '').trim()
  const arrival = (row.arrival_time ?? '').trim()
  const hasStart = clockPattern.test(start)
  const requested = (row.time_status ?? '').trim().toLowerCase()
  const timing_status = hasStart && requested !== 'tbc' ? (requested === 'estimated' ? 'estimated' : 'confirmed') : 'tbc'
  return {
    timing_status,
    starts_at: melbourneFixtureStart(row.date, hasStart ? start : '00:00'),
    arrival_at: clockPattern.test(arrival) ? melbourneFixtureStart(row.date, arrival) : null,
  }
}

export function mapFixtureRows(parsed: Record<string, string>[], options: FixtureOption[]): FixtureRow[] {
  const teams = options.filter((item) => item.kind === 'team')
  const venues = options.filter((item) => item.kind === 'venue')
  const externalClubs = options.filter((item) => item.kind === 'external_club')
  const mapped = parsed.map((row, index) => {
    const team = teams.find((item) => item.name.toLowerCase() === row.team.trim().toLowerCase())
    const opponentKey = normalizeClubName(row.opponent ?? '')
    const opponent = teams.find((item) => item.name.toLowerCase() === row.opponent.trim().toLowerCase() && item.org_id === team?.org_id)
      ?? externalClubs.find((item) => item.org_id === team?.org_id && [normalizeClubName(item.name), ...(item.aliases ?? '').split('|').filter(Boolean)].includes(opponentKey))
    // Same rule as validate_fixture_import: this club's own venue of the name wins; otherwise one shared venue of another club.
    const venueNamed = venues.filter((item) => item.name.toLowerCase() === row.venue.trim().toLowerCase())
    const ownVenue = venueNamed.find((item) => item.org_id === team?.org_id)
    const sharedVenues = venueNamed.filter((item) => item.shared && item.org_id !== team?.org_id)
    const venue = ownVenue ?? (sharedVenues.length === 1 ? sharedVenues[0] : undefined)
    const date = normalizeDate(row.date)
    const problems = [!date && 'invalid date', !row.round?.trim() && 'missing round', !row.opponent?.trim() && 'missing opponent', !['home', 'away'].includes(row.home_away?.trim().toLowerCase()) && 'home_away must be home or away', !row.team?.trim() && 'missing team', !row.venue?.trim() && 'missing venue', !row.season?.trim() && 'missing season', row.team && !team && 'team not found', row.opponent && team && !opponent && 'opponent team not found', row.venue && team && !venue && 'venue not found', team && team.season_name?.toLowerCase() !== row.season.trim().toLowerCase() && 'team is not assigned to this season'].filter(Boolean)
    return { ...row, date: date ?? row.date, source_row: index + 2, source_date_raw: row.date, ...fixtureTiming({ date: date ?? row.date, start_time: row.start_time, arrival_time: row.arrival_time, time_status: row.time_status }), org_id: team?.org_id, division_id: team?.division_id, home_team_id: row.home_away?.trim().toLowerCase() === 'home' ? team?.id : opponent?.id, away_team_id: row.home_away?.trim().toLowerCase() === 'home' ? opponent?.id : team?.id, venue_id: venue?.id, issue: problems.join(', ') }
  })
  // CSV headers are validated row by row through `issue`; missing values are
  // retained as empty strings so the component can show those errors.
  return mapped as FixtureRow[]
}

import { describe, expect, it } from 'vitest'
import { mapFixtureRows, type FixtureOption } from '../src/pages/fixtureImportLogic'

// Mirrors validate_fixture_import: this club's own venue of a name wins; otherwise exactly one shared venue of another club.
const options: FixtureOption[] = [
  { kind: 'team', id: 'ta', name: 'Northside', org_id: 'a', division_id: 'da', season_name: '2026' },
  { kind: 'team', id: 'tb', name: 'Lakeside', org_id: 'a', division_id: 'da', season_name: '2026' },
  { kind: 'venue', id: 'va-hall', name: 'Hall', org_id: 'a', shared: 0 },
  { kind: 'venue', id: 'vb-hall', name: 'Hall', org_id: 'b', shared: 1 },
  { kind: 'venue', id: 'vb-harbour', name: 'Harbour', org_id: 'b', shared: 1 },
  { kind: 'venue', id: 'vb-oval', name: 'Oval', org_id: 'b', shared: 1 },
  { kind: 'venue', id: 'vc-oval', name: 'Oval', org_id: 'c', shared: 1 },
  { kind: 'venue', id: 'vb-private', name: 'Private', org_id: 'b', shared: 0 },
]

const rowAt = (venue: string) => mapFixtureRows([{ date: '2026-05-09', round: 'R2', opponent: 'Lakeside', home_away: 'home', venue, team: 'Northside', season: '2026', start_time: '14:00', arrival_time: '', time_status: '', timezone: '' }], options)[0]

describe('import venue matching', () => {
  it('uses this club own venue even when another club shares one of the same name', () => {
    expect(rowAt('Hall').venue_id).toBe('va-hall')
  })

  it('uses a single shared venue from another club', () => {
    expect(rowAt('Harbour').venue_id).toBe('vb-harbour')
    expect(rowAt('Harbour').issue).toBe('')
  })

  it('does not guess between two shared venues of the same name', () => {
    expect(rowAt('Oval').venue_id).toBeUndefined()
    expect(rowAt('Oval').issue).toContain('venue not found')
  })

  it('never matches another club unshared venue', () => {
    expect(rowAt('Private').venue_id).toBeUndefined()
    expect(rowAt('Private').issue).toContain('venue not found')
  })
})

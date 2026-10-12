import { describe, expect, it } from 'vitest'
import { fixtureArrivalLabel, fixtureStartLabel } from '../src/fixtureTime'

describe('fixture time labels', () => {
  it('never shows a TBC or estimated start as a confirmed time', () => {
    const tbc = fixtureStartLabel({ starts_at: '2026-05-16T00:00:00+10:00', time_status: 'tbc' })
    expect(tbc).toContain('start time TBC')
    expect(tbc).not.toMatch(/\d:\d\d/)
    expect(fixtureStartLabel({ starts_at: '2026-05-16T09:00:00+10:00', time_status: 'estimated' })).toContain('(estimated)')
    expect(fixtureStartLabel({ starts_at: '2026-05-16T15:00:00+10:00', time_status: 'confirmed' })).not.toContain('estimated')
  })

  it('shows arrival separately and only when recorded', () => {
    expect(fixtureArrivalLabel({ starts_at: '2026-05-16T15:00:00+10:00', arrival_at: '2026-05-16T14:30:00+10:00' })).toMatch(/^Arrival \/ check-in /)
    expect(fixtureArrivalLabel({ starts_at: '2026-05-16T15:00:00+10:00', arrival_at: null })).toBeNull()
  })
})

import { describe, expect, it, vi } from 'vitest'
import { emit, toEventData, type LogSink, type TelemetryEvent } from '../src/telemetry/events'

// Structured telemetry schema (issue #36): only the declared fields and types reach the log.

const completed: TelemetryEvent = { name: 'import.completed', kind: 'fixtures', received: 12, saved: 10, rejected: 2, status: 'saved', blocking: 1, warnings: 3 }

describe('telemetry schema', () => {
  it('keeps exactly the declared fields and drops anything else', () => {
    const data = toEventData({ ...completed, display_name: 'Alex Smith', user_id: 'gh-1', note: 'free text' } as never)
    expect(data).toEqual({ kind: 'fixtures', received: 12, saved: 10, rejected: 2, status: 'saved', blocking: 1, warnings: 3 })
  })

  it('drops an event whose name is not in the schema', () => {
    expect(toEventData({ name: 'user.clicked', kind: 'fixtures' })).toBeNull()
  })

  it('drops an event when a required field is missing', () => {
    const { warnings: _omitted, ...incomplete } = completed as TelemetryEvent & { name: 'import.completed' }
    expect(toEventData(incomplete as never)).toBeNull()
  })

  it('rejects counts that are negative, fractional, or implausibly large', () => {
    expect(toEventData({ ...completed, saved: -1 } as never)).toBeNull()
    expect(toEventData({ ...completed, saved: 2.5 } as never)).toBeNull()
    expect(toEventData({ ...completed, saved: 5_000_000 } as never)).toBeNull()
  })

  it('rounds durations and rejects non-finite or negative ones', () => {
    expect(toEventData({ name: 'page.view', route: 'fixtures', render_ms: 12.6 })).toEqual({ route: 'fixtures', render_ms: 13 })
    expect(toEventData({ name: 'page.view', route: 'fixtures', render_ms: Number.NaN })).toBeNull()
    expect(toEventData({ name: 'page.view', route: 'fixtures', render_ms: -4 })).toBeNull()
  })

  it('rejects enumerated values outside their set', () => {
    expect(toEventData({ ...completed, status: 'deleted' } as never)).toBeNull()
    expect(toEventData({ name: 'score.submitted', outcome: 'maybe', applied: null })).toBeNull()
  })

  it('allows a null applied outcome when a submission was refused before it was applied', () => {
    expect(toEventData({ name: 'score.submitted', outcome: 'refused', applied: null })).toEqual({ outcome: 'refused', applied: null })
  })

  it('refuses identifier-like or personal values in token fields', () => {
    for (const action of ['alex@example.com', 'Alex Smith', 'user-1234567890', '0412 345 678', 'Create Season', '']) {
      expect(toEventData({ name: 'write.refused', action, target_type: 'club_record' })).toBeNull()
    }
    expect(toEventData({ name: 'write.refused', action: 'update_venue', target_type: 'club_record' })).toEqual({ action: 'update_venue', target_type: 'club_record' })
  })

  it('never produces a value containing an e-mail address or a space, whatever the input', () => {
    const hostile = ['a@b.co', 'Sam Lee', 'x y', '+61 412 345 678', 'contact sam@example.com']
    for (const value of hostile) {
      const data = toEventData({ name: 'import.anomaly', kind: 'roster', code: value, severity: 'warning', count: 1 })
      expect(data).toBeNull()
    }
  })
})

describe('emit', () => {
  it('sends the level, the event name as category and message, and the schema data', () => {
    const capture = vi.fn()
    expect(emit({ capture } as LogSink, { name: 'write.refused', action: 'update_venue', target_type: 'club_record' })).toBe(true)
    expect(capture).toHaveBeenCalledWith('warn', 'write.refused', 'write.refused', { action: 'update_venue', target_type: 'club_record' })
  })

  it('uses info for routine events and warn for anomalies', () => {
    const capture = vi.fn()
    emit({ capture } as LogSink, completed)
    emit({ capture } as LogSink, { name: 'import.anomaly', kind: 'fixtures', code: 'duplicate_fixture', severity: 'blocking', count: 2 })
    expect(capture.mock.calls[0][0]).toBe('info')
    expect(capture.mock.calls[1][0]).toBe('warn')
  })

  it('sends nothing for an invalid event, and reports that it did not send', () => {
    const capture = vi.fn()
    expect(emit({ capture } as LogSink, { name: 'write.refused', action: 'a@b.co', target_type: 'club_record' })).toBe(false)
    expect(capture).not.toHaveBeenCalled()
  })

  it('does nothing without a log sink', () => {
    expect(emit(undefined, completed)).toBe(false)
  })

  it('never throws when the sink fails', () => {
    const capture = vi.fn(() => { throw new Error('network down') })
    expect(() => emit({ capture } as LogSink, completed)).not.toThrow()
    expect(emit({ capture } as LogSink, completed)).toBe(false)
  })
})

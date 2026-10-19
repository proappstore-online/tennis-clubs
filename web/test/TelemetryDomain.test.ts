import { describe, expect, it, vi } from 'vitest'
import { importAnomalyEvents, importCompletedEvent, scoreSubmittedEvent, writeRefusedEvent } from '../src/telemetry/domain'
import { emit, toEventData, type LogSink } from '../src/telemetry/events'
import type { ValidationIssue } from '../src/pages/fixtureImportLogic'

// Domain events for imports, score submission and refused writes (issue #36).

const issue = (overrides: Partial<ValidationIssue> = {}): ValidationIssue => ({
  source_row: 7, severity: 'blocking', code: 'duplicate_fixture', field: 'starts_at', message: 'Sam Lee already plays Hill on 2026-10-20 at 09:00 (sam@example.com)', remediation: 'Call 0412 345 678', ...overrides,
})

describe('import events', () => {
  it('counts rejected rows as received minus saved, never negative', () => {
    expect(importCompletedEvent({ kind: 'fixtures', received: 12, saved: 10, status: 'saved', blocking: 1, warnings: 3 })).toMatchObject({ received: 12, saved: 10, rejected: 2 })
    expect(importCompletedEvent({ kind: 'roster', received: 5, saved: 9, status: 'saved', blocking: 0, warnings: 0 })).toMatchObject({ saved: 5, rejected: 0 })
  })

  it('builds a completion event that passes the schema', () => {
    const event = importCompletedEvent({ kind: 'fixtures', received: 4, saved: 4, status: 'saved', blocking: 0, warnings: 0 })
    expect(toEventData(event as never)).not.toBeNull()
  })

  it('groups issues by severity and code, with a count for each group', () => {
    const events = importAnomalyEvents('fixtures', [issue(), issue({ source_row: 8 }), issue({ source_row: 9, severity: 'warning', code: 'late_start' })])
    expect(events).toEqual([
      { name: 'import.anomaly', kind: 'fixtures', code: 'duplicate_fixture', severity: 'blocking', count: 2 },
      { name: 'import.anomaly', kind: 'fixtures', code: 'late_start', severity: 'warning', count: 1 },
    ])
  })

  it('never carries an issue message, field, remediation or source row', () => {
    const [event] = importAnomalyEvents('fixtures', [issue()])
    const data = toEventData(event as never)
    expect(Object.keys(data ?? {}).sort()).toEqual(['code', 'count', 'kind', 'severity'])
    const printed = JSON.stringify(data)
    for (const secret of ['Sam', 'sam@example.com', '0412', 'starts_at', 'Call', 'source_row']) expect(printed).not.toContain(secret)
  })

  it('drops an anomaly whose code is not a plain token', () => {
    const capture = vi.fn()
    const [event] = importAnomalyEvents('fixtures', [issue({ code: 'Sam Lee' })])
    expect(emit({ capture } as LogSink, event)).toBe(false)
    expect(capture).not.toHaveBeenCalled()
  })
})

describe('score and refusal events', () => {
  it('records the submission outcome and the apply outcome', () => {
    expect(scoreSubmittedEvent('succeeded', 'succeeded')).toEqual({ name: 'score.submitted', outcome: 'succeeded', applied: 'succeeded' })
    expect(scoreSubmittedEvent('refused', null)).toEqual({ name: 'score.submitted', outcome: 'refused', applied: null })
  })

  it('records a refused write by action and target type only', () => {
    const event = writeRefusedEvent('set_team_player_pool', 'team_player')
    expect(toEventData(event as never)).toEqual({ action: 'set_team_player_pool', target_type: 'team_player' })
  })
})

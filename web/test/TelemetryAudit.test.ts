import { describe, expect, it, vi } from 'vitest'
import { outcomeOf, recordAudit } from '../src/pages/auditTrail'

// A refused write is reported once, from recordAudit, for every page that audits its writes (issue #36).

const target = { orgId: 'club-1', action: 'update_venue', targetType: 'club_record', targetId: 'venue-9' }

function app(logs?: { capture: ReturnType<typeof vi.fn> }) {
  return { actions: { call: vi.fn(async () => ({})) }, ...(logs ? { logs } : {}) } as never
}

describe('write refusal telemetry', () => {
  it('reports a refused write by action and target type, without the target id or club', async () => {
    const capture = vi.fn()
    await recordAudit(app({ capture }), { ...target, outcome: 'refused' })
    expect(capture).toHaveBeenCalledTimes(1)
    expect(capture).toHaveBeenCalledWith('warn', 'write.refused', 'write.refused', { action: 'update_venue', target_type: 'club_record' })
    expect(JSON.stringify(capture.mock.calls)).not.toContain('venue-9')
    expect(JSON.stringify(capture.mock.calls)).not.toContain('club-1')
  })

  it('reports nothing for a succeeded write', async () => {
    const capture = vi.fn()
    await recordAudit(app({ capture }), { ...target, outcome: 'succeeded' })
    expect(capture).not.toHaveBeenCalled()
  })

  it('still records the audit when there is no log sink', async () => {
    const client = app()
    await expect(recordAudit(client, { ...target, outcome: 'refused' })).resolves.toBe(true)
    expect(client.actions.call).toHaveBeenCalledWith('record_audit_event', expect.objectContaining({ outcome: 'refused' }))
  })

  it('treats a write that changed no rows as refused', () => {
    expect(outcomeOf({ changes: 0 })).toBe('refused')
    expect(outcomeOf({ meta: { changes: 1 } })).toBe('succeeded')
  })
})

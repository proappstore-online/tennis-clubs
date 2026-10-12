import { describe, expect, it, vi } from 'vitest'
import { outcomeOf, recordAudit } from '../src/pages/auditTrail'
import { MCP_CATALOG } from '../src/generated/mcpCatalog'

describe('audit trail helpers', () => {
  it('treats a zero-change write as refused and anything else as succeeded', () => {
    expect(outcomeOf({ changes: 0 })).toBe('refused')
    expect(outcomeOf({ meta: { changes: 0 } })).toBe('refused')
    expect(outcomeOf({ changes: 1 })).toBe('succeeded')
    expect(outcomeOf({})).toBe('succeeded')
  })

  it('records the target through record_audit_event', async () => {
    const call = vi.fn().mockResolvedValue({})
    const recorded = await recordAudit({ actions: { call } }, { orgId: 'org-1', action: 'update_venue', targetType: 'club_record', targetId: 'venue-1', outcome: 'succeeded' })
    expect(recorded).toBe(true)
    expect(call).toHaveBeenCalledWith('record_audit_event', expect.objectContaining({ org_id: 'org-1', action: 'update_venue', target_id: 'venue-1', outcome: 'succeeded' }))
  })

  it('reports a failed audit write without throwing', async () => {
    const call = vi.fn().mockRejectedValue(new Error('denied'))
    const recorded = await recordAudit({ actions: { call } }, { orgId: 'org-1', action: 'update_venue', targetType: 'club_record', targetId: 'venue-1', outcome: 'refused' })
    expect(recorded).toBe(false)
  })
})

describe('generated integration catalog', () => {
  it('lists the discoverable actions with roles and idempotency', () => {
    const names = MCP_CATALOG.map((entry) => entry.name)
    expect(names).toEqual(expect.arrayContaining(['get_club', 'list_authorised_documents', 'record_audit_event', 'get_my_club_permissions']))
    expect(MCP_CATALOG.find((entry) => entry.name === 'create_season')?.roles).toEqual(['admin', 'convenor', 'manager'])
    expect(MCP_CATALOG.find((entry) => entry.name === 'accept_team_invite')?.idempotency).toBe('idempotent')
  })

  it('never exposes SQL or private data in the catalog', () => {
    const serialised = JSON.stringify(MCP_CATALOG)
    expect(serialised).not.toMatch(/SELECT |INSERT INTO|UPDATE [a-z_]+ SET|DELETE FROM/)
    expect(MCP_CATALOG.every((entry) => !('sql' in entry))).toBe(true)
  })
})

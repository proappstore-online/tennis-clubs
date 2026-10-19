import { emit, type LogSink } from '../telemetry/events'
import { writeRefusedEvent } from '../telemetry/domain'

type ActionCaller = { actions: { call<T = unknown>(name: string, values: Record<string, unknown>): Promise<T> }; logs?: LogSink }

export type AuditOutcome = 'succeeded' | 'refused'

export function outcomeOf(result: unknown): AuditOutcome {
  const record = (result ?? {}) as { changes?: number; meta?: { changes?: number } }
  return (record.changes ?? record.meta?.changes) === 0 ? 'refused' : 'succeeded'
}

export async function recordAudit(
  app: ActionCaller,
  entry: { orgId: string; action: string; targetType: string; targetId: string | null; outcome: AuditOutcome },
): Promise<boolean> {
  // A refused write is reported once, here, for every page that audits its writes (issue #36).
  if (entry.outcome === 'refused') emit(app.logs, writeRefusedEvent(entry.action, entry.targetType))
  try {
    await app.actions.call('record_audit_event', {
      id: crypto.randomUUID(),
      org_id: entry.orgId,
      action: entry.action,
      target_type: entry.targetType,
      target_id: entry.targetId,
      outcome: entry.outcome,
    })
    return true
  } catch {
    return false
  }
}

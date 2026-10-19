import type { ValidationIssue } from '../pages/fixtureImportLogic'
import type { ImportKind, Outcome, TelemetryEvent } from './events'

// Builds the events for the domain flows (issue #36). Each builder takes only counts, codes and fixed outcomes: the
// issue's message, field, remediation and source row are never passed in, so they cannot reach telemetry.

export function importCompletedEvent(input: { kind: ImportKind; received: number; saved: number; status: 'saved' | 'rejected'; blocking: number; warnings: number }): TelemetryEvent {
  const received = Math.max(0, input.received)
  const saved = Math.min(Math.max(0, input.saved), received)
  return { name: 'import.completed', kind: input.kind, received, saved, rejected: received - saved, status: input.status, blocking: Math.max(0, input.blocking), warnings: Math.max(0, input.warnings) }
}

// One event per (code, severity) pair, with the number of rows that raised it.
export function importAnomalyEvents(kind: ImportKind, issues: ValidationIssue[]): TelemetryEvent[] {
  const counts = new Map<string, { code: string; severity: 'blocking' | 'warning'; count: number }>()
  for (const issue of issues) {
    const key = `${issue.severity}:${issue.code}`
    const existing = counts.get(key)
    if (existing) existing.count++
    else counts.set(key, { code: issue.code, severity: issue.severity, count: 1 })
  }
  return [...counts.values()].map((entry) => ({ name: 'import.anomaly', kind, code: entry.code, severity: entry.severity, count: entry.count }))
}

export function scoreSubmittedEvent(outcome: Outcome, applied: Outcome | null): TelemetryEvent {
  return { name: 'score.submitted', outcome, applied }
}

export function writeRefusedEvent(action: string, targetType: string): TelemetryEvent {
  return { name: 'write.refused', action, target_type: targetType }
}

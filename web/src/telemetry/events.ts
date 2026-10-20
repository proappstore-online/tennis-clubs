// Structured telemetry (issue #36). Events go to the app log sink (`app.logs`), which accepts anonymous reports.
// Every event is built from a closed schema: each event name lists the only fields it may carry, and each field has a
// fixed type. Free text, e-mail addresses, names and identifiers cannot be expressed in this schema, so they cannot reach
// the log. An event that fails its schema is dropped rather than sent in part. See docs/telemetry.md.

export type Outcome = 'succeeded' | 'refused'
export type ImportKind = 'fixtures' | 'roster'
export type IssueSeverity = 'blocking' | 'warning'

export type TelemetryEvent =
  | { name: 'import.completed'; kind: ImportKind; received: number; saved: number; rejected: number; status: 'saved' | 'rejected'; blocking: number; warnings: number }
  | { name: 'import.anomaly'; kind: ImportKind; code: string; severity: IssueSeverity; count: number }
  | { name: 'score.submitted'; outcome: Outcome; applied: Outcome | null }
  | { name: 'write.refused'; action: string; target_type: string }
  | { name: 'page.load'; route: string; ttfb_ms: number; dcl_ms: number; load_ms: number }
  | { name: 'page.view'; route: string; render_ms: number }
  | { name: 'page.error'; route: string; kind: 'render' }

export type EventName = TelemetryEvent['name']

// The app-log capture shape used by the SDK (`app.logs.capture(level, category, message, data)`).
export type LogSink = { capture(level: 'info' | 'warn' | 'error', category: string, message: string, data?: unknown): void }

type Check = (value: unknown) => unknown

const MAX_COUNT = 1_000_000
const MAX_MS = 600_000
// Lower-case identifiers such as 'duplicate_fixture', 'fixture_import' or 'write.refused'. No spaces, no '@', no digits-led IDs.
const TOKEN = /^[a-z][a-z0-9_.]{0,60}$/

const count: Check = (value) => (Number.isInteger(value) && (value as number) >= 0 && (value as number) <= MAX_COUNT ? value : undefined)
const millis: Check = (value) => (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= MAX_MS ? Math.round(value) : undefined)
const token: Check = (value) => (typeof value === 'string' && TOKEN.test(value) ? value : undefined)
const oneOf = (...allowed: string[]): Check => (value) => (typeof value === 'string' && allowed.includes(value) ? value : undefined)
const nullable = (check: Check): Check => (value) => (value === null ? null : check(value))

const OUTCOME = oneOf('succeeded', 'refused')
const KIND = oneOf('fixtures', 'roster')

// The schema. Every listed field is required; a field absent from this table is never sent.
const SCHEMAS: Record<EventName, Record<string, Check>> = {
  'import.completed': { kind: KIND, received: count, saved: count, rejected: count, status: oneOf('saved', 'rejected'), blocking: count, warnings: count },
  'import.anomaly': { kind: KIND, code: token, severity: oneOf('blocking', 'warning'), count },
  'score.submitted': { outcome: OUTCOME, applied: nullable(OUTCOME) },
  'write.refused': { action: token, target_type: token },
  'page.load': { route: token, ttfb_ms: millis, dcl_ms: millis, load_ms: millis },
  'page.view': { route: token, render_ms: millis },
  'page.error': { route: token, kind: oneOf('render') },
}

// Warnings are routine (a manager accepts them); a refusal or an anomaly is worth a look.
const LEVEL: Record<EventName, 'info' | 'warn'> = {
  'import.completed': 'info',
  'import.anomaly': 'warn',
  'score.submitted': 'info',
  'write.refused': 'warn',
  'page.load': 'info',
  'page.view': 'info',
  'page.error': 'warn',
}

// Returns the event's data with only its schema fields, or null when the event is unknown or a field fails its check.
export function toEventData(event: { name: string } & Record<string, unknown>): Record<string, unknown> | null {
  const schema = SCHEMAS[event.name as EventName]
  if (!schema) return null
  const data: Record<string, unknown> = {}
  for (const [field, check] of Object.entries(schema)) {
    const value = check(event[field])
    if (value === undefined) return null
    data[field] = value
  }
  return data
}

// Sends one event. Telemetry must never break the app, so a missing sink or a failing capture is ignored.
export function emit(logs: LogSink | undefined, event: TelemetryEvent): boolean {
  const data = toEventData(event)
  if (!data || !logs) return false
  try {
    logs.capture(LEVEL[event.name], event.name, event.name, data)
    return true
  } catch {
    return false
  }
}

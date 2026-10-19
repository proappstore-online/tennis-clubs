// Safe logging (issue #34). Application logs must not carry personal data (docs/privacy-data-classification.md).
// Every log line goes through `safeLog`, which redacts personal-data fields and values before printing.
// Opaque record IDs (fixture, team, venue) are kept; identifiers that link to a person are redacted.

export const REDACTED = '[redacted]'

// Field names that hold personal data, whatever object they appear in. Matched case-insensitively.
const PERSONAL_KEYS = new Set([
  'name', 'display_name', 'displayname', 'player_name', 'playername', 'login', 'avatar_url', 'avatarurl',
  'email', 'phone', 'convenor_phone', 'contact', 'value', 'postal', 'address', 'notes',
  'date_of_birth', 'dateofbirth', 'dob',
  'user_id', 'userid', 'actor_user_id', 'created_by', 'updated_by', 'reviewed_by', 'importer_user_id', 'scorecard_user_id',
  'source_row', 'source_date_raw', 'source_time_raw',
  'token', 'authorization', 'cookie', 'secret', 'claim_token',
])

const EMAIL = /[^\s@<>()[\]]+@[^\s@<>()[\]]+\.[a-z]{2,}/gi
// A run of digits, optionally spaced or punctuated, of nine or more digits (phone numbers). Shorter runs
// such as ISO dates (8 digits) and times are left alone.
const PHONE = /\+?\d[\d ().-]{6,}\d/g

function digitCount(text: string) {
  return (text.match(/\d/g) ?? []).length
}

export function redactText(text: string): string {
  return text
    .replace(EMAIL, REDACTED)
    .replace(PHONE, (match) => (digitCount(match) >= 9 ? REDACTED : match))
}

function redactKey(key: string, value: unknown) {
  return PERSONAL_KEYS.has(key.toLowerCase()) ? REDACTED : redactValue(value)
}

// Recursively redacts a value: personal keys are replaced, and strings are scanned for emails and phone numbers.
export function redactValue(value: unknown, depth = 0): unknown {
  if (depth > 8) return REDACTED
  if (typeof value === 'string') return redactText(value)
  if (Array.isArray(value)) return value.map((item) => redactValue(item, depth + 1))
  if (value instanceof Error) return { name: value.name, message: redactText(value.message) }
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactKey(key, item)]))
  }
  return value
}

export type LogLevel = 'info' | 'warn' | 'error'

// The only way the app writes to the console. Callers pass a message and a context; neither may carry personal data
// unredacted, so both are redacted here before printing.
export function safeLog(level: LogLevel, message: string, context: Record<string, unknown> = {}) {
  const line = redactText(message)
  const fields = redactValue(context) as Record<string, unknown>
  console[level](line, fields)
}

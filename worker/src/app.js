// App worker for Tennis Clubs document downloads and uploads (ADR-009).
// Browser requests arrive at /.pas/worker/documents/<id>/<verb>?org=<club>. The platform
// verifies the signed-in user and passes the envelope with `caller`; every action below runs
// as that user, so the SQL role gates in mcp.json decide access. Zero dependencies: the
// envelope and binding shapes mirror @proappstore/sdk 1.16 (worker.js) and must stay in step.

const MAX_BYTES = 10 * 1024 * 1024
const ALLOWED_TYPES = ['application/pdf', 'image/png', 'image/jpeg', 'image/webp']
const SAFE_ID = /^[A-Za-z0-9_-]{1,80}$/
const ROUTE = /^\/documents\/([A-Za-z0-9_-]{1,80})\/(download|upload)$/

const NO_STORE = { 'Cache-Control': 'no-store' }

// Competition-draw import (issue #1). The route runs the dry run and the apply steps of mcp.json; the whole write is
// one PAS batch, which is one transaction, so a failed step leaves nothing behind.
const DRAW_PATH = '/draw/import'
const MAX_DRAW_BYTES = 2 * 1024 * 1024
const DRAW_APPLY_STEPS = [
  'apply_draw_seasons', 'apply_draw_divisions', 'apply_draw_venues', 'apply_draw_external_clubs',
  'apply_draw_external_aliases', 'apply_draw_placeholders', 'apply_draw_teams', 'apply_draw_fixtures',
  'apply_draw_roster', 'apply_draw_venue_updates', 'apply_draw_fixture_updates', 'apply_draw_provenance',
]
const OUTCOMES = ['created', 'updated', 'skipped', 'conflicted', 'failed']
// Roster players and external opponent names are personal or identifying, so the report refers to them by position only.
const REDACTED_ENTITIES = new Set(['roster', 'external_alias'])

function plain(status, message) {
  return new Response(message, { status, headers: NO_STORE })
}

function storageKey(orgId, documentId) {
  return `docs/${orgId}/${documentId}`
}

function hex(buffer) {
  return Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

async function sha256Hex(bytes) {
  return hex(await crypto.subtle.digest('SHA-256', bytes))
}

// The same body decoding as the SDK's hookBody: utf8 unless the platform says base64.
function requestBytes(payload) {
  const body = typeof payload.body === 'string' ? payload.body : ''
  if (payload.body_encoding !== 'base64') return new TextEncoder().encode(body)
  const binary = atob(body)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

function headerValue(headers, name) {
  const found = Object.entries(headers ?? {}).find(([key]) => key.toLowerCase() === name)
  return found ? String(found[1]) : ''
}

function safeFilename(title, documentId) {
  const base = String(title ?? '').replace(/[^A-Za-z0-9 ._-]+/g, '_').trim().slice(0, 80)
  return base ? base : documentId
}

// Actions run as the signed-in user (their grant), with the worker's token for the call.
function userClient(env, invocation, caller) {
  const pas = env.PAS
  if (!pas) throw new Error('this worker has no PAS binding')
  const ctx = { token: env.PAS_WORKER_TOKEN ?? '', invocation, as: caller }
  return {
    call: (name, params) => pas.actions.call(name, params, ctx),
    batch: (calls) => pas.actions.batch(calls, ctx),
    storage: pas.storage,
    workerCtx: { token: env.PAS_WORKER_TOKEN ?? '', invocation },
    env,
  }
}

// The server decides the outcome from the caller's visibility; the worker only reports the attempt.
async function logAccess(client, orgId, documentId, action) {
  await client.call('log_document_access', { id: crypto.randomUUID(), org_id: orgId, document_id: documentId, action })
}

async function download(client, orgId, documentId) {
  const found = await client.call('check_document_access', { org_id: orgId, document_id: documentId })
  const document = (found?.rows ?? [])[0]
  if (!document) {
    await logAccess(client, orgId, documentId, 'download')
    return plain(404, 'not found')
  }
  const object = await client.storage.get(storageKey(orgId, documentId), client.workerCtx)
  if (!object) return plain(503, 'the file is not available yet')
  const bytes = new Uint8Array(object.body)
  if ((await sha256Hex(bytes)) !== document.sha256) return plain(500, 'the stored file failed its integrity check')
  await logAccess(client, orgId, documentId, 'download')
  return new Response(bytes, {
    status: 200,
    headers: {
      'Content-Type': document.content_type,
      'Content-Length': String(bytes.byteLength),
      'Content-Disposition': `attachment; filename="${safeFilename(document.title, documentId)}"`,
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  })
}

async function upload(client, orgId, documentId, payload) {
  const found = await client.call('check_document_upload', { org_id: orgId, document_id: documentId })
  const registered = (found?.rows ?? [])[0]
  if (!registered) return plain(404, 'not found')
  const contentType = headerValue(payload.headers, 'content-type').split(';')[0].trim().toLowerCase()
  if (!ALLOWED_TYPES.includes(contentType) || contentType !== registered.content_type) {
    return plain(415, 'the content type does not match the registered document')
  }
  const bytes = requestBytes(payload)
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_BYTES || bytes.byteLength !== registered.byte_size) {
    return plain(422, 'the file size does not match the registered document')
  }
  const digest = await sha256Hex(bytes)
  if (digest !== registered.sha256) return plain(422, 'the file hash does not match the registered document')
  const key = storageKey(orgId, documentId)
  await client.storage.put(key, bytes, { contentType }, client.workerCtx)
  const marked = await client.call('mark_document_stored', { org_id: orgId, document_id: documentId, storage_key: key, content_type: contentType, byte_size: bytes.byteLength, sha256: digest })
  // A mark that changed no rows means the document was withdrawn or already stored; nothing is audited as stored.
  if (marked?.changes === 0 || marked?.meta?.changes === 0) return plain(409, 'the document is no longer waiting for its file')
  await client.call('record_audit_event', { id: crypto.randomUUID(), org_id: orgId, action: 'mark_document_stored', target_type: 'document', target_id: documentId, outcome: 'succeeded' })
  return Response.json({ status: 'stored', sha256: digest }, { status: 201, headers: NO_STORE })
}

function drawJson(status, body) {
  return Response.json(body, { status, headers: NO_STORE })
}

function drawCounts(rows) {
  const counts = Object.fromEntries(OUTCOMES.map((outcome) => [outcome, 0]))
  for (const row of rows) if (row.outcome in counts) counts[row.outcome] += 1
  return counts
}

// One entry per planned record, in plan order. Roster and alias names are never reported.
function drawRecords(rows) {
  return rows.map((row, position) => ({
    position,
    entity_type: row.entity_type,
    source_key: REDACTED_ENTITIES.has(row.entity_type) ? null : row.source_key,
    action: row.action,
    severity: row.severity,
    outcome: row.outcome,
    ...(row.severity === 'blocking' ? { code: row.message } : {}),
  }))
}

// changes is the number of rows one apply step wrote (PAS execute results carry it).
function changesOf(result) {
  return result?.changes ?? result?.meta?.changes ?? null
}

async function drawImport(client, payload, orgId, caller, dryRun) {
  if (String(payload.method ?? 'GET').toUpperCase() !== 'POST') return plain(405, 'method not allowed')
  const bytes = requestBytes(payload)
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_DRAW_BYTES) return plain(413, 'the draw payload is empty or too large')
  const text = new TextDecoder().decode(bytes)
  let draw
  try {
    draw = JSON.parse(text)
  } catch {
    return drawJson(400, { status: 'rejected', errors: [{ code: 'invalid_json' }] })
  }
  const digest = await sha256Hex(bytes)
  // The dry run returns no rows to a caller who is not an administrator of the club (the SQL gate), so nothing is planned.
  const rows = (await client.call('import_competition_draw', { org_id: orgId, payload: text }))?.rows ?? []
  if (rows.length === 0) return drawJson(403, { status: 'forbidden', errors: [{ code: 'not_club_administrator' }] })
  const blocking = rows.filter((row) => row.severity === 'blocking')
  const base = {
    importer: caller?.user_id ?? null,
    import_time: new Date().toISOString(),
    source: { system: draw?.source_system ?? null, run: draw?.source_run ?? null, payload_sha256: digest },
    planned: drawCounts(rows),
    records: drawRecords(rows),
  }
  if (dryRun) return drawJson(200, { ...base, status: 'dry_run', valid: blocking.length === 0, counts: drawCounts([]) })
  // Any blocking row means the apply steps would write nothing, so the import is refused before the batch starts.
  if (blocking.length > 0) {
    return drawJson(422, { ...base, status: 'rejected', valid: false, counts: drawCounts([]), errors: drawRecords(blocking).map(({ entity_type, source_key, code }) => ({ entity_type, source_key, code })) })
  }
  const runId = crypto.randomUUID()
  const calls = [
    { name: 'record_draw_import_run', params: { org_id: orgId, import_run_id: runId, source_system: base.source.system, source_run: base.source.run, payload_sha256: digest } },
    ...DRAW_APPLY_STEPS.map((name) => ({ name, params: { org_id: orgId, payload: text, ...(name === 'apply_draw_provenance' ? { import_run_id: runId } : {}) } })),
    { name: 'record_draw_import_outcomes', params: { org_id: orgId, import_run_id: runId, outcomes: JSON.stringify(rows) } },
  ]
  let results
  try {
    results = await client.batch(calls)
  } catch {
    // The batch rolled back as a whole: no run, no records, no provenance. The cause is not returned to the caller.
    return drawJson(500, { ...base, status: 'rolled_back', valid: true, counts: drawCounts([]), import_run_id: runId, errors: [{ code: 'transaction_failed' }] })
  }
  const steps = Object.fromEntries(results.map((step) => [step.name, changesOf(step.results?.[0])]))
  return drawJson(201, { ...base, status: 'imported', valid: true, counts: drawCounts(rows), import_run_id: runId, steps })
}

export default {
  async fetch(request, env) {
    let envelope
    try {
      envelope = await request.json()
    } catch {
      return plain(400, 'invalid envelope')
    }
    if (envelope.type !== 'http') return plain(404, 'no handler for this event')
    const payload = envelope.payload ?? {}
    const method = String(payload.method ?? 'GET').toUpperCase()
    const path = String(payload.path ?? '/')
    const query = new URLSearchParams(typeof payload.query === 'string' ? payload.query : '')
    if (envelope.caller === undefined || envelope.caller === null) return plain(401, 'sign in to use documents')
    if (path === DRAW_PATH) {
      const orgId = query.get('org') ?? ''
      if (!SAFE_ID.test(orgId)) return plain(404, 'not found')
      const client = userClient(env, `${envelope.id}:${envelope.attempt ?? 1}`, envelope.caller)
      return drawImport(client, payload, orgId, envelope.caller, query.get('dry_run') === 'true')
    }
    const match = ROUTE.exec(path)
    const orgId = query.get('org') ?? ''
    if (!match || !SAFE_ID.test(orgId)) return plain(404, 'not found')
    const [, documentId, verb] = match
    const client = userClient(env, `${envelope.id}:${envelope.attempt ?? 1}`, envelope.caller)
    if (verb === 'download') {
      if (method !== 'GET' && method !== 'HEAD') return plain(405, 'method not allowed')
      return download(client, orgId, documentId)
    }
    if (method !== 'POST') return plain(405, 'method not allowed')
    return upload(client, orgId, documentId, payload)
  },
}

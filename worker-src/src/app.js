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
  await client.call('mark_document_stored', { org_id: orgId, document_id: documentId, storage_key: key, content_type: contentType, byte_size: bytes.byteLength, sha256: digest })
  await client.call('record_audit_event', { id: crypto.randomUUID(), org_id: orgId, action: 'mark_document_stored', target_type: 'document', target_id: documentId, outcome: 'succeeded' })
  return Response.json({ status: 'stored', sha256: digest }, { status: 201, headers: NO_STORE })
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

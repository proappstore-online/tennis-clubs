// Mirrors the worker's limits in worker/src/app.js; the server checks them again on upload.
export const DOCUMENT_TYPES = ['application/pdf', 'image/png', 'image/jpeg', 'image/webp'] as const
export const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024
export const DOCUMENT_ACCEPT = DOCUMENT_TYPES.join(',')

export function documentFileProblem(file: { type: string; size: number }): string | null {
  if (!(DOCUMENT_TYPES as readonly string[]).includes(file.type)) return 'Choose a PDF, PNG, JPEG or WebP file.'
  if (file.size === 0) return 'The file is empty.'
  if (file.size > MAX_DOCUMENT_BYTES) return 'The file is larger than 10 MB.'
  return null
}

export async function sha256Of(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

export function filenameFrom(disposition: string | null): string | null {
  const match = /filename="([^"]+)"/.exec(disposition ?? '')
  return match ? match[1] : null
}

export function downloadMessage(status: number): string {
  if (status === 404) return 'You cannot download this document, or it is no longer available.'
  if (status === 503) return 'This file is not available yet. Ask a manager to upload it.'
  if (status === 500) return 'This file failed its integrity check. Ask a manager to upload it again.'
  if (status === 401) return 'Sign in again to download this document.'
  return 'The file could not be downloaded. Try again.'
}

export function uploadMessage(status: number): string {
  if (status === 201) return 'File uploaded.'
  if (status === 415) return 'This file type does not match the registered document.'
  if (status === 422) return 'This file does not match the size or fingerprint of the registered document. Choose the file that was registered.'
  if (status === 409) return 'This document is no longer waiting for a file.'
  if (status === 404) return 'This document cannot take a file.'
  if (status === 401) return 'Sign in again to upload this file.'
  return 'The file could not be uploaded. Try again with the same file.'
}

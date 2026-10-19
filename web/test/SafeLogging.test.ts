import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { redactText, safeLog } from '../src/privacy/redact'

// Guard tests for issue #34: no personal data reaches the console (docs/privacy-data-classification.md, "Logging").

// Vitest runs from the web package (pnpm --filter or npx in web), so the repo root is its parent.
const ROOT = resolve(dirname(process.cwd()))

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return sourceFiles(path)
    return /\.(ts|tsx|js|mjs)$/.test(name) ? [path] : []
  })
}

describe('safe logger', () => {
  afterEach(() => vi.restoreAllMocks())

  it('keeps opaque record IDs and drops personal fields', () => {
    const spy = vi.spyOn(console, 'info').mockImplementation(() => {})
    safeLog('info', 'availability saved', {
      fixture_id: 'fixture-42',
      action: 'set_my_fixture_availability',
      display_name: 'Alex Smith',
      user_id: 'gh-99321',
      email: 'alex@example.com',
      phone: '0412 345 678',
    })
    const printed = JSON.stringify(spy.mock.calls)
    expect(printed).toContain('fixture-42')
    expect(printed).toContain('set_my_fixture_availability')
    for (const secret of ['Alex', 'gh-99321', 'alex@example.com', '0412', '345 678']) expect(printed).not.toContain(secret)
  })

  it('redacts emails and phone numbers that appear in free text and in errors', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    safeLog('error', 'Could not contact alex@example.com on +61 412 345 678', { error: new Error('lookup failed for 0412345678') })
    const printed = JSON.stringify(spy.mock.calls)
    expect(printed).not.toContain('alex@example.com')
    expect(printed).not.toContain('412 345 678')
    expect(printed).not.toContain('0412345678')
  })

  it('redacts personal fields nested inside arrays and objects', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    safeLog('warn', 'roster imported', { rows: [{ player_name: 'Jordan Lee', fixture_id: 'f7' }, { player_name: 'Sam Ray' }] })
    const printed = JSON.stringify(spy.mock.calls)
    expect(printed).toContain('f7')
    expect(printed).not.toContain('Jordan')
    expect(printed).not.toContain('Sam Ray')
  })

  it('keeps dates, times and short numbers that are not phone numbers', () => {
    expect(redactText('Import 2026-10-20 at 10:30 with 12 rows')).toBe('Import 2026-10-20 at 10:30 with 12 rows')
  })

  it('redacts invite codes and tokens', () => {
    const spy = vi.spyOn(console, 'info').mockImplementation(() => {})
    safeLog('info', 'invite accepted', { claim_token: 'tok-abc', token: 'secret-value' })
    const printed = JSON.stringify(spy.mock.calls)
    expect(printed).not.toContain('tok-abc')
    expect(printed).not.toContain('secret-value')
  })
})

// Static guard: every console call in the app and worker must go through the safe logger, so personal data cannot
// reach the console by a raw call. The safe logger itself is the one file allowed to call console.
describe('logging guard', () => {
  const allowed = new Set([join(ROOT, 'web/src/privacy/redact.ts')])
  const files = [...sourceFiles(join(ROOT, 'web/src')), ...sourceFiles(join(ROOT, 'worker/src'))]

  it('scans the app and worker sources', () => {
    expect(files.length).toBeGreaterThan(10)
  })

  it('no source file calls console directly outside the safe logger', () => {
    const offenders = files
      .filter((file) => !allowed.has(file))
      .filter((file) => /\bconsole\.(log|info|warn|error|debug|trace)\s*\(/.test(readFileSync(file, 'utf8')))
      .map((file) => relative(ROOT, file))
    expect(offenders).toEqual([])
  })
})

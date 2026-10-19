import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// Static guards for telemetry (issue #36).

const ROOT = resolve(dirname(process.cwd()))
const SRC = join(ROOT, 'web/src')
const EVENTS_FILE = join(SRC, 'telemetry/events.ts')

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return sources(path)
    return /\.(ts|tsx)$/.test(name) ? [path] : []
  })
}

const files = sources(SRC)
const read = (file: string) => readFileSync(file, 'utf8')

describe('telemetry guards', () => {
  it('only the telemetry schema calls the log sink directly', () => {
    // Anything that writes to app.logs must go through emit(), where the schema is applied.
    const direct = /\blogs\.(capture|info|warn|error|debug|captureAuthEvent)\s*\(/
    const offenders = files.filter((file) => file !== EVENTS_FILE && direct.test(read(file))).map((file) => relative(ROOT, file))
    expect(offenders).toEqual([])
  })

  it('every event name in the schema is emitted from the app', () => {
    const schema = read(EVENTS_FILE)
    const names = [...schema.matchAll(/^\s*'([a-z.]+)': \{/gm)].map((match) => match[1])
    expect(names.length).toBeGreaterThanOrEqual(6)
    const emitters = files.filter((file) => file !== EVENTS_FILE)
    for (const name of names) {
      const emitted = emitters.some((file) => read(file).includes(`'${name}'`))
      expect(emitted, `no emitter for ${name}`).toBe(true)
    }
  })
})

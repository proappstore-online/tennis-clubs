import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getLocationConsent, hasLocationConsent, LOCATION_CONSENT_KEY, LOCATION_CONSENT_VERSION, LocationConsentRequired, readLocationWithConsent, recordLocationConsent } from '../src/location/consent'

// Consent-aware location (issue #34): a device position is only read after the user has agreed.

function fakeKv(initial: Record<string, unknown> = {}) {
  const store = new Map<string, unknown>(Object.entries(initial))
  return {
    store,
    kv: {
      get: vi.fn(async (key: string) => store.get(key) ?? null),
      set: vi.fn(async (key: string, value: unknown) => { store.set(key, value) }),
    },
  }
}

const position = { coords: { latitude: -37.8, longitude: 144.9 }, timestamp: 1 } as GeolocationPosition

describe('location consent', () => {
  let getCurrentPosition: ReturnType<typeof vi.fn>

  beforeEach(() => {
    getCurrentPosition = vi.fn((resolve: (value: GeolocationPosition) => void) => resolve(position))
    Object.defineProperty(navigator, 'geolocation', { value: { getCurrentPosition }, configurable: true })
  })
  afterEach(() => {
    Reflect.deleteProperty(navigator, 'geolocation')
    vi.restoreAllMocks()
  })

  it('never asks the device for a position when no consent has been recorded', async () => {
    const { kv } = fakeKv()
    await expect(readLocationWithConsent({ kv } as never)).rejects.toBeInstanceOf(LocationConsentRequired)
    expect(getCurrentPosition).not.toHaveBeenCalled()
  })

  it('does not read location after the user refuses', async () => {
    const { kv } = fakeKv()
    await recordLocationConsent({ kv } as never, false)
    await expect(readLocationWithConsent({ kv } as never)).rejects.toBeInstanceOf(LocationConsentRequired)
    expect(getCurrentPosition).not.toHaveBeenCalled()
  })

  it('reads the position once the user has granted consent', async () => {
    const { kv } = fakeKv()
    await recordLocationConsent({ kv } as never, true, 1000)
    await expect(readLocationWithConsent({ kv } as never)).resolves.toBe(position)
    expect(getCurrentPosition).toHaveBeenCalledTimes(1)
  })

  it('stops reading location once the user withdraws consent', async () => {
    const { kv } = fakeKv()
    await recordLocationConsent({ kv } as never, true)
    await recordLocationConsent({ kv } as never, false)
    await expect(readLocationWithConsent({ kv } as never)).rejects.toBeInstanceOf(LocationConsentRequired)
    expect(getCurrentPosition).not.toHaveBeenCalled()
  })

  it('ignores consent given for an earlier version of the request', async () => {
    const { kv } = fakeKv({ [LOCATION_CONSENT_KEY]: { granted: true, version: LOCATION_CONSENT_VERSION - 1, decidedAt: 1 } })
    await expect(readLocationWithConsent({ kv } as never)).rejects.toBeInstanceOf(LocationConsentRequired)
    expect(getCurrentPosition).not.toHaveBeenCalled()
  })

  it('stores the decision per user under one key, with the version and time', async () => {
    const { kv, store } = fakeKv()
    await recordLocationConsent({ kv } as never, true, 42)
    expect(store.get(LOCATION_CONSENT_KEY)).toEqual({ granted: true, version: LOCATION_CONSENT_VERSION, decidedAt: 42 })
    expect(hasLocationConsent(await getLocationConsent({ kv } as never))).toBe(true)
  })

  it('fails clearly, without touching the device, on a device with no geolocation', async () => {
    Reflect.deleteProperty(navigator, 'geolocation')
    const { kv } = fakeKv({ [LOCATION_CONSENT_KEY]: { granted: true, version: LOCATION_CONSENT_VERSION, decidedAt: 1 } })
    await expect(readLocationWithConsent({ kv } as never)).rejects.toThrow('not available on this device')
  })
})

// Static guard: navigator.geolocation is referenced only by the consent module, so no other code can read location.
describe('location guard', () => {
  const ROOT = resolve(dirname(process.cwd()))
  const allowed = join(ROOT, 'web/src/location/consent.ts')
  function sources(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const path = join(dir, name)
      if (statSync(path).isDirectory()) return sources(path)
      return /\.(ts|tsx|js|mjs)$/.test(name) ? [path] : []
    })
  }

  it('only the consent module references geolocation', () => {
    const offenders = [...sources(join(ROOT, 'web/src')), ...sources(join(ROOT, 'worker/src'))]
      .filter((file) => file !== allowed)
      .filter((file) => /geolocation/i.test(readFileSync(file, 'utf8')))
      .map((file) => relative(ROOT, file))
    expect(offenders).toEqual([])
  })
})

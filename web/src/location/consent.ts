import type { ProAppStore } from '@proappstore/sdk'

// Consent-aware location (issue #34). A device position is personal data (docs/privacy-data-classification.md),
// so it is read only after this user has agreed to it. The record is stored per user in the SDK's per-user store and
// can be withdrawn. This is the only module that may call navigator.geolocation; a guard test enforces that.

export const LOCATION_CONSENT_KEY = 'location-consent'
// Bump when the wording or purpose of the location request changes, so earlier consent no longer counts.
export const LOCATION_CONSENT_VERSION = 1

export type LocationConsent = { granted: boolean; version: number; decidedAt: number }

export class LocationConsentRequired extends Error {
  constructor() {
    super('Location is only used after you agree to share it.')
    this.name = 'LocationConsentRequired'
  }
}

export async function getLocationConsent(app: Pick<ProAppStore, 'kv'>): Promise<LocationConsent | null> {
  return app.kv.get<LocationConsent>(LOCATION_CONSENT_KEY)
}

// Records the user's decision. Passing false withdraws consent.
export async function recordLocationConsent(app: Pick<ProAppStore, 'kv'>, granted: boolean, now = Date.now()) {
  await app.kv.set<LocationConsent>(LOCATION_CONSENT_KEY, { granted, version: LOCATION_CONSENT_VERSION, decidedAt: now })
}

// Consent counts only when it was granted, and for the current version of the request.
export function hasLocationConsent(consent: LocationConsent | null): boolean {
  return consent?.granted === true && consent.version === LOCATION_CONSENT_VERSION
}

// Reads the device position if, and only if, the user has consented. Denies by default: no consent, a refusal,
// a withdrawal or an outdated version all throw before the device is asked for anything.
export async function readLocationWithConsent(app: Pick<ProAppStore, 'kv'>, options?: PositionOptions): Promise<GeolocationPosition> {
  if (!hasLocationConsent(await getLocationConsent(app))) throw new LocationConsentRequired()
  if (!('geolocation' in navigator)) throw new Error('Location is not available on this device.')
  return new Promise((resolve, reject) => navigator.geolocation.getCurrentPosition(resolve, reject, options))
}

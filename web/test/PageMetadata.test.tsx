import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { applyPageMeta, DEFAULT_DESCRIPTION, PUBLIC_ROUTES, SIGN_IN_META, SITE_NAME, SITE_ORIGIN, signedInMeta, signedInTitle } from '../src/seo'

// Mocked so the App module (which calls initPro at import time) loads without the platform SDK.
vi.mock('@proappstore/sdk', async () => ({ initPro: () => ({}), useAuth: () => ({ user: null, loading: false, signOut: vi.fn() }), ProShell: () => null, PageHeader: () => null }))
vi.mock('../src/pages/ClubAdmin', () => ({ default: () => null }))
vi.mock('../src/pages/RosterAdmin', () => ({ default: () => null }))
vi.mock('../src/pages/FixtureImport', () => ({ default: () => null }))
vi.mock('../src/pages/FixtureList', () => ({ default: () => null }))
vi.mock('../src/pages/DocumentLibrary', () => ({ default: () => null }))
vi.mock('../src/pages/ImportReview', () => ({ default: () => null }))

import { NAV } from '../src/App'

const source = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')

// Every signed-in page type the app routes to, with its tab title.
const SIGNED_IN_PAGES: [string, string][] = [
  ['/', 'Comps — Tennis Clubs'],
  ['/fixtures', 'Upcoming fixtures — Tennis Clubs'],
  ['/fixture-import', 'Import fixtures — Tennis Clubs'],
  ['/rosters', 'Fixture rosters — Tennis Clubs'],
  ['/documents', 'Documents — Tennis Clubs'],
  ['/import-review', 'Import review — Tennis Clubs'],
  ['/admin', 'Club administration — Tennis Clubs'],
]

describe('signed-in page metadata, per page type', () => {
  for (const [path, title] of SIGNED_IN_PAGES) {
    it(`${path}: title "${title}", excluded from search, canonical to the site root`, () => {
      const meta = signedInMeta(signedInTitle(path, NAV))
      expect(signedInTitle(path, NAV)).toBe(title)
      expect(meta.robots).toBe('noindex, nofollow')
      expect(meta.canonical).toBe(`${SITE_ORIGIN}/`)
      expect(meta.description).toBe(DEFAULT_DESCRIPTION)
    })
  }

  it('invitation links get a team title and never expose the invite code in their canonical or share URL', () => {
    const meta = signedInMeta(signedInTitle('/join/SECRET-CODE-123', NAV))
    expect(meta.title).toBe(`Team invitation — ${SITE_NAME}`)
    expect(meta.canonical).not.toContain('SECRET')
    expect(meta.robots).toBe('noindex, nofollow')
  })

  it('an unknown path falls back to the site name and is still excluded from search', () => {
    expect(signedInTitle('/nope', NAV)).toBe(SITE_NAME)
    expect(signedInMeta(signedInTitle('/nope', NAV)).robots).toBe('noindex, nofollow')
  })
})

describe('public (signed-out) page metadata', () => {
  it('the sign-in screen is indexable, titled, and canonical to the site root', () => {
    expect(SIGN_IN_META.robots).toBe('index, follow')
    expect(SIGN_IN_META.canonical).toBe(`${SITE_ORIGIN}/`)
    expect(SIGN_IN_META.title).toBe(`${SITE_NAME} — Sign in`)
  })

  it('the only public route is the site root', () => {
    expect(PUBLIC_ROUTES).toEqual(['/'])
  })
})

describe('sitemap and robots', () => {
  it('sitemap.xml lists exactly the public routes as absolute URLs', () => {
    const locs = [...source('../public/sitemap.xml').matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1])
    expect(locs.sort()).toEqual(PUBLIC_ROUTES.map((route) => `${SITE_ORIGIN}${route}`).sort())
  })

  it('robots.txt points crawlers at the sitemap and does not block signed-in pages (so their noindex tag can be read)', () => {
    const robots = source('../public/robots.txt')
    expect(robots).toContain(`Sitemap: ${SITE_ORIGIN}/sitemap.xml`)
    expect(robots).not.toMatch(/^Disallow:/m)
  })
})

describe('static shell', () => {
  it('index.html carries a canonical link and an og:url for the site root', () => {
    const html = source('../index.html')
    expect(html).toContain(`<link rel="canonical" href="${SITE_ORIGIN}/" />`)
    expect(html).toContain(`<meta property="og:url" content="${SITE_ORIGIN}/" />`)
  })
})

describe('applyPageMeta', () => {
  beforeEach(() => {
    document.head.innerHTML = '<meta name="description" content="old"><meta property="og:title" content="Tennis Clubs">'
  })
  afterEach(() => {
    document.head.innerHTML = ''
  })

  it('updates existing tags and creates missing ones, without duplicating either', () => {
    applyPageMeta(signedInMeta('Fixtures — Tennis Clubs'))
    applyPageMeta(signedInMeta('Fixtures — Tennis Clubs'))
    expect(document.head.querySelectorAll('meta[name="description"]')).toHaveLength(1)
    expect(document.head.querySelector('meta[name="description"]')?.getAttribute('content')).toBe(DEFAULT_DESCRIPTION)
    expect(document.head.querySelectorAll('meta[property="og:title"]')).toHaveLength(1)
    expect(document.head.querySelector('meta[property="og:title"]')?.getAttribute('content')).toBe('Fixtures — Tennis Clubs')
    expect(document.head.querySelector('meta[name="robots"]')?.getAttribute('content')).toBe('noindex, nofollow')
    expect(document.head.querySelector('link[rel="canonical"]')?.getAttribute('href')).toBe(`${SITE_ORIGIN}/`)
  })

  it('does not change document.title, which ProShell owns on signed-in pages', () => {
    document.title = 'Comps — Tennis Clubs'
    applyPageMeta(signedInMeta('Fixtures — Tennis Clubs'))
    expect(document.title).toBe('Comps — Tennis Clubs')
  })
})

describe('signed-out App', () => {
  it('sets the sign-in title and metadata at any path, canonical to the site root', async () => {
    const { cleanup, render } = await import('@testing-library/react')
    const App = (await import('../src/App')).default
    window.history.replaceState({}, '', '/fixtures')
    render(<App />)
    expect(document.title).toBe(`${SITE_NAME} — Sign in`)
    expect(document.head.querySelector('meta[name="robots"]')?.getAttribute('content')).toBe('index, follow')
    expect(document.head.querySelector('link[rel="canonical"]')?.getAttribute('href')).toBe(`${SITE_ORIGIN}/`)
    cleanup()
    window.history.replaceState({}, '', '/')
  })
})

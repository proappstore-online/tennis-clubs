// Canonical URLs, titles and share metadata (issue #33).
//
// Tennis Clubs has no anonymous pages: every club, fixture, roster and document view sits behind sign-in
// (CLAUDE.md, "no anonymous/public read access"). So the only public page is the sign-in screen, which is
// what a signed-out visitor sees at any path. Signed-in views are marked noindex and point their canonical
// link at the site root, so an invite code in /join/<code> never reaches a canonical URL or a search index.

export const SITE_ORIGIN = 'https://tennis-clubs.proappstore.online'
export const SITE_NAME = 'Tennis Clubs'
export const DEFAULT_DESCRIPTION = 'Fixtures, team rosters and match-day details for your tennis club.'

// Routes that are indexable and listed in sitemap.xml. Keep in step with web/public/sitemap.xml.
export const PUBLIC_ROUTES = ['/'] as const

export type PageMeta = { title: string; description: string; canonical: string; robots: string }

export const SIGN_IN_META: PageMeta = {
  title: `${SITE_NAME} — Sign in`,
  description: DEFAULT_DESCRIPTION,
  canonical: `${SITE_ORIGIN}/`,
  robots: 'index, follow',
}

// Every signed-in view shares one canonical URL and is excluded from search results.
export function signedInMeta(title: string): PageMeta {
  return { title, description: DEFAULT_DESCRIPTION, canonical: `${SITE_ORIGIN}/`, robots: 'noindex, nofollow' }
}

// The tab title for a signed-in path: the matching nav item's title, as ProShell sets it, or the site name.
// Invitation links (/join/<code>) are not in the nav, so they get their own title here.
export function signedInTitle(path: string, nav: { href: string; title?: string }[]): string {
  if (path.startsWith('/join/')) return `Team invitation — ${SITE_NAME}`
  return nav.find((item) => item.href === path)?.title ?? SITE_NAME
}

// Creates the tag if the shell does not have it, then sets its value.
function upsertTag(selector: string, create: () => HTMLElement, attribute: 'content' | 'href', value: string) {
  let element = document.head.querySelector<HTMLElement>(selector)
  if (!element) {
    element = create()
    document.head.appendChild(element)
  }
  element.setAttribute(attribute, value)
}

function metaTag(attribute: 'name' | 'property', key: string, value: string) {
  upsertTag(`meta[${attribute}="${key}"]`, () => {
    const element = document.createElement('meta')
    element.setAttribute(attribute, key)
    return element
  }, 'content', value)
}

// Sets the description, robots, canonical and share (Open Graph / Twitter) tags to match a page.
// The document title is not set here: ProShell owns it on signed-in pages, and the sign-in screen sets it itself.
export function applyPageMeta(meta: PageMeta) {
  metaTag('name', 'description', meta.description)
  metaTag('name', 'robots', meta.robots)
  metaTag('property', 'og:title', meta.title)
  metaTag('property', 'og:description', meta.description)
  metaTag('property', 'og:url', meta.canonical)
  metaTag('name', 'twitter:title', meta.title)
  metaTag('name', 'twitter:description', meta.description)
  upsertTag('link[rel="canonical"]', () => {
    const element = document.createElement('link')
    element.setAttribute('rel', 'canonical')
    return element
  }, 'href', meta.canonical)
}

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// Design-system and accessibility baseline (issue #26). These guard the rules that the
// rest of the UI depends on, so a later edit cannot quietly remove them.
// The sources are read as text: Vitest does not run CSS through the module graph, so a ?raw import of the stylesheet is empty.
const source = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
const css = source('../src/index.css')
const appSource = source('../src/App.tsx')

describe('accessibility baseline', () => {
  it('shows a visible keyboard focus ring on every interactive control, not only buttons and links', () => {
    for (const control of ['button', 'a', 'input', 'select', 'textarea']) {
      expect(css).toContain(`${control}:focus-visible`)
    }
  })

  it('keeps native controls at least 44px tall so they are easy to tap', () => {
    expect(css).toMatch(/button,\s*input,\s*select,\s*textarea\s*\{\s*min-height:\s*44px;/)
  })

  it('turns off motion for users who ask for reduced motion', () => {
    const block = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'))
    expect(block).toContain('transition-duration: 0.01ms !important')
    expect(block).toContain('animation-duration: 0.01ms !important')
    expect(block).toMatch(/button:active\s*\{\s*transform:\s*none;/)
  })
})

describe('responsive design system', () => {
  it('is mobile-first: breakpoints only widen from the phone layout, never narrow it', () => {
    const queries = css.match(/@media[^{]+/g) ?? []
    expect(queries.length).toBeGreaterThan(0)
    for (const query of queries) {
      expect(query).not.toMatch(/max-width/)
    }
  })
})

describe('skip link and main landmark target', () => {
  it('puts a skip link to the page content before the navigation', () => {
    const skip = appSource.indexOf('href="#main-content"')
    const nav = appSource.indexOf('{nav}')
    expect(skip).toBeGreaterThan(-1)
    expect(nav).toBeGreaterThan(-1)
    expect(skip).toBeLessThan(nav)
    expect(appSource).toContain('Skip to main content')
  })

  it('gives the skip link a focusable target that receives focus when followed', () => {
    expect(appSource).toContain('<div id="main-content" tabIndex={-1}')
  })
})

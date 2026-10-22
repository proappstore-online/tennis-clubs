import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import FixtureList from '../src/pages/FixtureList'
import { CardGrid, PageFrame, Stack } from '../src/ui/layout'

// Shared responsive layout primitives (issue #40). The stylesheet is read as text: Vitest does not run CSS through the
// module graph, and jsdom does not lay out CSS, so the layout rules are checked from the source.
const source = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
const css = source('../src/index.css')

afterEach(cleanup)

// Every declaration block for a class selector, including the ones inside media queries.
function blocksFor(selector: string): string[] {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return [...css.matchAll(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`, 'g'))].map((match) => match[1])
}

describe('layout primitives: stylesheet', () => {
  // A primitive that fixes a height could shrink a control below 44px, and one that animates would bypass the
  // reduced-motion rule if it were written outside it. So the primitives declare neither.
  it.each(['.container-app', '.stack', '.stack-sm', '.stack-lg', '.grid-auto', '.grid-3'])(
    '%s sets no height, transition, animation or transform, so controls keep their 44px minimum and motion stays under the reduced-motion rule',
    (selector) => {
      const blocks = blocksFor(selector)
      expect(blocks.length).toBeGreaterThan(0)
      for (const block of blocks) {
        expect(block).not.toMatch(/(^|[;\s{])(height|max-height|min-height|transition|animation|transform)\s*:/)
      }
    },
  )

  it('keeps the global 44px control rule and the reduced-motion rule that the primitives rely on', () => {
    expect(css).toMatch(/button,\s*input,\s*select,\s*textarea\s*\{\s*min-height:\s*44px;/)
    expect(css).toContain('@media (prefers-reduced-motion: reduce)')
    expect(css).toContain('transition-duration: 0.01ms !important')
  })

  it('starts every grid as one column on a phone and only widens with min-width queries', () => {
    for (const selector of ['.grid-auto', '.grid-3']) {
      const [base, ...wider] = blocksFor(selector)
      expect(base).toContain('grid-template-columns: 1fr;')
      expect(wider.length).toBeGreaterThan(0)
    }
    for (const query of css.match(/@media[^{]+/g) ?? []) expect(query).not.toMatch(/max-width/)
  })
})

describe('layout primitives: components', () => {
  it('PageFrame is one padded, centred main landmark', () => {
    render(<PageFrame>content</PageFrame>)
    const main = screen.getByRole('main')
    expect(main.className).toContain('container-app')
    expect(main.textContent).toBe('content')
  })

  it('Stack picks its gap class and keeps list semantics for a list', () => {
    const { container } = render(<><Stack gap="sm">a</Stack><Stack>b</Stack><Stack gap="lg">c</Stack><Stack as="ul"><li>d</li></Stack></>)
    expect([...container.children].map((element) => element.className)).toEqual(['stack-sm', 'stack', 'stack-lg', 'stack list-none'])
    expect(screen.getByRole('list').tagName).toBe('UL')
  })

  it('CardGrid is the auto grid by default and the three-column grid on request', () => {
    const { container } = render(<><CardGrid>a</CardGrid><CardGrid columns={3} as="section">b</CardGrid></>)
    expect(container.children[0].className).toBe('grid-auto')
    expect(container.children[1].className).toBe('grid-3')
    expect(container.children[1].tagName).toBe('SECTION')
  })

  it('adds a caller class without losing the primitive class', () => {
    const { container } = render(<Stack className="mt-4">x</Stack>)
    expect(container.firstElementChild?.className).toBe('stack mt-4')
  })

  it('does not change its children, so a button inside keeps its own classes and no inline height', () => {
    render(<Stack><button className="custom">Go</button></Stack>)
    const button = screen.getByRole('button', { name: 'Go' })
    expect(button.className).toBe('custom')
    expect(button.getAttribute('style')).toBeNull()
  })
})

describe('layout primitives: used by the pages', () => {
  const fixture = { id: 'f1', starts_at: '2026-05-16T15:00:00+10:00', time_status: 'confirmed', arrival_at: null, round_label: 'R1', home_team_name: 'Northside', away_team_name: 'Lakeside', venue_name: 'Central Courts', venue_address: null, member_side: 'home', opponent_name: 'Lakeside', is_external_opponent: 0 }

  it('the fixture page uses PageFrame and Stack', async () => {
    const app = { actions: { call: vi.fn(async () => ({ rows: [fixture] })) } } as never
    const { container } = render(<FixtureList app={app} />)
    await screen.findByRole('heading', { name: 'Northside vs Lakeside' })
    expect(container.querySelector('main.container-app')).not.toBeNull()
    expect(container.querySelector('ul.stack')).not.toBeNull()
  })

  it('the directory page (Comps) uses PageFrame, CardGrid and Stack', () => {
    const app = source('../src/App.tsx')
    for (const usage of ['<PageFrame>', '<CardGrid as="section" columns={3}', '<Stack as="ul"', '<Stack className="mt-4">']) {
      expect(app).toContain(usage)
    }
  })

  it('the pages no longer hand-write the layout classes the primitives own', () => {
    for (const path of ['../src/App.tsx', '../src/pages/FixtureList.tsx']) {
      const text = source(path)
      expect(text).not.toContain('<main className="container-app')
      expect(text).not.toMatch(/className="[^"]*\bgrid list-none gap-3\b/)
    }
  })
})

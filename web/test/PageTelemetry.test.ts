import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { routeName } from '../src/telemetry/pages'
import type { LogSink } from '../src/telemetry/events'

// Page timing telemetry (issue #36). Route names are fixed; raw paths and invite codes are never sent.

const NAV = [{ href: '/' }, { href: '/fixtures' }, { href: '/fixture-import' }, { href: '/rosters' }, { href: '/documents' }, { href: '/import-review' }, { href: '/admin' }]

describe('routeName', () => {
  it('maps each signed-in screen to a fixed name', () => {
    expect(routeName('/', NAV)).toBe('comps')
    expect(routeName('/fixtures', NAV)).toBe('fixtures')
    expect(routeName('/fixture-import', NAV)).toBe('fixture_import')
    expect(routeName('/import-review', NAV)).toBe('import_review')
    expect(routeName('/admin', NAV)).toBe('admin')
  })

  it('never includes an invitation code', () => {
    expect(routeName('/join/SECRET-CODE-123', NAV)).toBe('join')
  })

  it('gives unknown paths a fixed name rather than echoing them', () => {
    expect(routeName('/some/private/path', NAV)).toBe('other')
  })

  it('only ever produces a lower-case token', () => {
    for (const path of ['/', '/fixtures', '/fixture-import', '/join/x', '/nope', '/a.b']) {
      expect(routeName(path, NAV)).toMatch(/^[a-z][a-z0-9_.]{0,60}$/)
    }
  })
})

describe('page timing', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('reports render time for a view as a page.view event', async () => {
    const { reportPageView } = await import('../src/telemetry/pages')
    const capture = vi.fn()
    vi.spyOn(performance, 'now').mockReturnValue(1_250.4)
    reportPageView({ capture } as LogSink, 'fixtures', 1_000)
    expect(capture).toHaveBeenCalledWith('info', 'page.view', 'page.view', { route: 'fixtures', render_ms: 250 })
  })

  it('reports load timing once per document, after the load event has finished', async () => {
    const { reportPageLoad } = await import('../src/telemetry/pages')
    const capture = vi.fn()
    vi.spyOn(document, 'readyState', 'get').mockReturnValue('complete')
    vi.spyOn(performance, 'getEntriesByType').mockReturnValue([{ responseStart: 40, domContentLoadedEventEnd: 300, loadEventEnd: 720 }] as never)
    reportPageLoad({ capture } as LogSink, 'comps')
    reportPageLoad({ capture } as LogSink, 'comps')
    vi.runAllTimers()
    expect(capture).toHaveBeenCalledTimes(1)
    expect(capture).toHaveBeenCalledWith('info', 'page.load', 'page.load', { route: 'comps', ttfb_ms: 40, dcl_ms: 300, load_ms: 720 })
  })

  it('does not report load timing while the load event is still running', async () => {
    const { reportPageLoad } = await import('../src/telemetry/pages')
    const capture = vi.fn()
    vi.spyOn(document, 'readyState', 'get').mockReturnValue('complete')
    vi.spyOn(performance, 'getEntriesByType').mockReturnValue([{ responseStart: 40, domContentLoadedEventEnd: 300, loadEventEnd: 0 }] as never)
    reportPageLoad({ capture } as LogSink, 'comps')
    vi.runAllTimers()
    expect(capture).not.toHaveBeenCalled()
  })
})

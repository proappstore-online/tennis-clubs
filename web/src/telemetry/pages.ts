import { emit, type LogSink } from './events'

// Page telemetry (issue #36): how long a screen takes to load and to render. Timings carry a fixed route name, never a
// raw path, because a path such as /join/<code> holds a secret. Errors are captured by the SDK's app.logs automatically.

// A fixed name for each screen. Invitation links and unknown paths get fixed names too.
export function routeName(path: string, nav: { href: string }[]): string {
  if (path.startsWith('/join/')) return 'join'
  if (path === '/') return 'comps'
  const item = nav.find((entry) => entry.href === path)
  return item ? item.href.slice(1).replace(/-/g, '_') : 'other'
}

let loadReported = false

// Reports the document's load timing once per page load, when the load event has finished.
export function reportPageLoad(logs: LogSink | undefined, route: string): void {
  if (loadReported) return
  loadReported = true
  const send = () => {
    const [entry] = performance.getEntriesByType('navigation') as PerformanceNavigationTiming[]
    if (!entry || entry.loadEventEnd <= 0) return
    emit(logs, { name: 'page.load', route, ttfb_ms: entry.responseStart, dcl_ms: entry.domContentLoadedEventEnd, load_ms: entry.loadEventEnd })
  }
  // Wait for the load event; its timing is only recorded once it has finished.
  if (document.readyState === 'complete') setTimeout(send, 0)
  else window.addEventListener('load', () => setTimeout(send, 0), { once: true })
}

// Reports how long a screen took to render, from the start of its render to its first commit.
export function reportPageView(logs: LogSink | undefined, route: string, renderStartedAt: number): void {
  emit(logs, { name: 'page.view', route, render_ms: performance.now() - renderStartedAt })
}

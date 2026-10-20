import { Component, type ErrorInfo, type ReactNode } from 'react'
import { emit, type LogSink } from './events'

type Props = { logs: LogSink | undefined; route: () => string; children: ReactNode }
type State = { failed: boolean }

// Catches a render failure on any page (issue #30). It reports page.error with the route and the kind only, never the
// error message, and shows a plain fallback in place of the screen.
export class PageErrorBoundary extends Component<Props, State> {
  state: State = { failed: false }

  static getDerivedStateFromError(): State {
    return { failed: true }
  }

  componentDidCatch(_error: unknown, _info: ErrorInfo) {
    emit(this.props.logs, { name: 'page.error', route: this.props.route(), kind: 'render' })
  }

  render() {
    if (this.state.failed) {
      return <main className="mx-auto max-w-xl px-4 py-16" role="alert"><h1 className="text-xl font-bold text-[var(--ink)]">This page could not be shown</h1><p className="mt-3 text-sm leading-6 text-[var(--muted)]">Refresh the page to try again. If it keeps happening, tell your club administrator.</p></main>
    }
    return this.props.children
  }
}

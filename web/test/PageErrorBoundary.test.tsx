import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { PageErrorBoundary } from '../src/telemetry/boundary'
import type { LogSink } from '../src/telemetry/events'

// A render failure is reported as page.error with the route and the kind only (issue #30).

function Broken({ message }: { message: string }): never {
  throw new Error(message)
}

describe('page error boundary', () => {
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('renders the page when nothing fails', () => {
    const capture = vi.fn()
    render(<PageErrorBoundary logs={{ capture } as LogSink} route={() => 'fixtures'}><p>Fixtures</p></PageErrorBoundary>)
    expect(screen.getByText('Fixtures')).toBeTruthy()
    expect(capture).not.toHaveBeenCalled()
  })

  it('shows a plain fallback and reports page.error with the route and kind, not the message', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const capture = vi.fn()
    render(<PageErrorBoundary logs={{ capture } as LogSink} route={() => 'fixtures'}><Broken message="Sam Smith sam@example.com failed" /></PageErrorBoundary>)
    expect(screen.getByRole('alert').textContent).toContain('This page could not be shown')
    expect(capture).toHaveBeenCalledTimes(1)
    expect(capture).toHaveBeenCalledWith('warn', 'page.error', 'page.error', { route: 'fixtures', kind: 'render' })
    expect(JSON.stringify(capture.mock.calls)).not.toContain('Sam Smith')
    expect(JSON.stringify(capture.mock.calls)).not.toContain('sam@example.com')
  })

  it('still shows the fallback when the log sink is missing or fails', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    render(<PageErrorBoundary logs={undefined} route={() => 'other'}><Broken message="x" /></PageErrorBoundary>)
    expect(screen.getByRole('alert')).toBeTruthy()
  })
})

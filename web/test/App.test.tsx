import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

const { authState, mockApp } = vi.hoisted(() => ({
  authState: { user: null as { id: string; login: string } | null, loading: false },
  mockApp: {
    auth: { signIn: vi.fn(), user: null as { id: string; login: string } | null },
    roles: { check: vi.fn() },
    actions: { call: vi.fn() },
  },
}))

vi.mock('@proappstore/sdk', async () => {
  const React = await import('react')
  return {
    initPro: () => mockApp,
    useAuth: () => ({ ...authState, signOut: vi.fn() }),
    ProShell: ({ children, renderTopbar, hideFooter }: {
      children: React.ReactNode
      hideFooter?: boolean
      renderTopbar?: (context: { appName: string; nav: React.ReactNode; profileMenu: React.ReactNode; textSizeToggle: React.ReactNode }) => React.ReactNode
    }) => React.createElement('div', { 'data-testid': 'pro-shell', 'data-hide-footer': String(hideFooter) },
      renderTopbar?.({
        appName: 'Tennis Clubs',
        nav: React.createElement('nav', { 'aria-label': 'Main' }, React.createElement('a', { href: '/' }, 'Comps')),
        profileMenu: React.createElement('button', null, 'Profile and account'),
        textSizeToggle: React.createElement('button', null, 'Text size'),
      }),
      children),
    PageHeader: ({ title }: { title: string }) => React.createElement('h1', null, title),
  }
})

vi.mock('../src/pages/ClubAdmin', () => ({ default: () => <h1>Club administration screen</h1> }))
vi.mock('../src/pages/RosterAdmin', () => ({ default: () => <h1>Roster administration screen</h1> }))
vi.mock('../src/pages/FixtureList', () => ({ default: () => <h1>Fixture list screen</h1> }))

import App from '../src/App'
import FixtureImport from '../src/pages/FixtureImport'

describe('App authentication composition', () => {
  beforeEach(() => {
    authState.user = null
    authState.loading = false
    mockApp.auth.signIn.mockReset()
    window.history.replaceState({}, '', '/')
  })

  afterEach(cleanup)

  it('shows the Google sign-in screen outside ProShell when signed out', () => {
    render(<App />)

    expect(screen.getByRole('button', { name: 'Continue with Google' })).toBeTruthy()
    expect(screen.queryByTestId('pro-shell')).toBeNull()
    expect(screen.queryByText(/proappstore/i)).toBeNull()
  })

  it('starts sign-in with the PAS Google provider', () => {
    render(<App />)
    fireEvent.click(screen.getByRole('button', { name: 'Continue with Google' }))

    expect(mockApp.auth.signIn).toHaveBeenCalledExactlyOnceWith('google')
  })

  it('keeps protected routes inside ProShell for signed-in users', () => {
    authState.user = { id: 'admin-user', login: 'admin' }
    window.history.replaceState({}, '', '/admin')

    render(<App />)

    expect(screen.getByTestId('pro-shell')).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Club administration screen' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Continue with Google' })).toBeNull()
  })

  it.each([390, 1440])('uses Tennis branding and retains shell controls at %i px', (width) => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: width })
    window.dispatchEvent(new Event('resize'))
    authState.user = { id: 'admin-user', login: 'admin' }
    window.history.replaceState({}, '', '/admin')

    render(<App />)

    const shell = screen.getByTestId('pro-shell')
    expect(shell.getAttribute('data-hide-footer')).toBe('true')
    expect(screen.getByRole('banner').textContent).toContain('Tennis Clubs')
    expect(screen.getByRole('banner').firstElementChild?.className).toContain('flex-wrap')
    expect(screen.getByRole('navigation', { name: 'Main' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Text size' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Profile and account' })).toBeTruthy()
    expect(screen.queryByText(/proappstore/i)).toBeNull()
  })

  it('waits for auth resolution before showing sign-in or protected content', () => {
    authState.loading = true

    render(<App />)

    expect(screen.getByRole('status').textContent).toContain('Checking your sign-in')
    expect(screen.queryByRole('button', { name: 'Continue with Google' })).toBeNull()
    expect(screen.queryByTestId('pro-shell')).toBeNull()
  })

  it.each([390, 1440])('keeps the public sign-in layout available at %i px viewport width', (width) => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: width })
    window.dispatchEvent(new Event('resize'))
    render(<App />)

    expect(screen.getByRole('button', { name: 'Continue with Google' })).toBeTruthy()
    expect(document.querySelector('main')?.className).toContain('px-4')
    expect(document.querySelector('section')?.className).toContain('sm:p-10')
    expect(screen.queryByTestId('pro-shell')).toBeNull()
  })
})

describe('fixture import role boundary', () => {
  afterEach(cleanup)

  it.each([
    ['manager', true],
    ['convenor', true],
    ['admin', true],
    ['player', false],
  ])('%s sees fixture import only when the server returns club import options', async (_role, allowed) => {
    mockApp.actions.call.mockResolvedValue({ rows: allowed ? [{ kind: 'team', name: 'Team A' }] : [] })
    render(<FixtureImport app={mockApp as never} />)

    fireEvent.click(screen.getByRole('button', { name: 'Check manager access' }))

    if (allowed) {
      await waitFor(() => expect(screen.getByText('Fixture book CSV')).toBeTruthy())
      expect(screen.queryByText('This page is for club managers and admins.')).toBeNull()
    } else {
      await waitFor(() => expect(screen.getByText('This page is for club managers and admins.')).toBeTruthy())
      expect(screen.queryByText('Fixture book CSV')).toBeNull()
    }
    expect(mockApp.roles.check).not.toHaveBeenCalled()
  })
})

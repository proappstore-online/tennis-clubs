import { StrictMode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'

const { authState, mockApp } = vi.hoisted(() => ({
  authState: { user: { id: 'player-1', login: 'player' } as { id: string; login: string } | null, loading: false },
  mockApp: {
    auth: { signIn: vi.fn(), user: { id: 'player-1', login: 'player' } as { id: string; login: string } | null },
    invites: { redeem: vi.fn() },
    actions: { call: vi.fn() },
  },
}))

vi.mock('@proappstore/sdk', async () => {
  const React = await import('react')
  return {
    initPro: () => mockApp,
    useAuth: () => ({ ...authState, signOut: vi.fn() }),
    ProShell: ({ children }: { children: React.ReactNode }) => React.createElement('div', null, children),
    PageHeader: ({ title }: { title: string }) => React.createElement('h1', null, title),
  }
})

import App from '../src/App'

describe('team invite acceptance', () => {
  beforeEach(() => {
    window.history.replaceState({}, '', '/join/HAWK42')
    mockApp.invites.redeem.mockReset()
    mockApp.actions.call.mockReset()
    mockApp.actions.call.mockResolvedValue({ rows: [] })
  })
  afterEach(cleanup)

  it('redeems the single-use invite once under StrictMode and reports the join', async () => {
    mockApp.invites.redeem.mockResolvedValue({ metadata: { claimToken: 'tok-1' } })
    render(<StrictMode><App /></StrictMode>)
    expect(await screen.findByText('You have joined the team. Open Club setup to view your fixtures.')).toBeTruthy()
    expect(mockApp.invites.redeem).toHaveBeenCalledTimes(1)
    expect(mockApp.actions.call).toHaveBeenCalledWith('accept_team_invite', { claim_token: 'tok-1', display_name: 'player' })
  })
  it('does not report a join when the membership accept changed nothing', async () => {
    mockApp.invites.redeem.mockResolvedValue({ metadata: { claimToken: 'tok-2' } })
    mockApp.actions.call.mockImplementation(async (name: string) => (name === 'accept_team_invite' ? { changes: 0 } : { rows: [] }))
    render(<App />)
    expect(await screen.findByText('This invite link could not be accepted. It may have expired or already been used. Ask the club for a fresh link.')).toBeTruthy()
    expect(screen.queryByText('You have joined the team. Open Club setup to view your fixtures.')).toBeNull()
  })

  it('tells the member a link without a team membership needs a fresh link, in Tennis Clubs wording', async () => {
    mockApp.invites.redeem.mockResolvedValue({ metadata: {} })
    render(<App />)
    const message = await screen.findByText('This invite link does not include a team membership. Ask the club for a fresh link.')
    expect(message).toBeTruthy()
    expect(mockApp.actions.call).not.toHaveBeenCalledWith('accept_team_invite', expect.anything())
  })

  it('shows Tennis Clubs wording for an expired or used link and never shows the raw SDK error', async () => {
    mockApp.invites.redeem.mockRejectedValue(new Error('PAS delegated invite group member limit reached (internal)'))
    render(<App />)
    const message = await screen.findByText('This invite link could not be accepted. It may have expired or already been used. Ask the club for a fresh link.')
    expect(message.textContent).not.toMatch(/PAS|delegat|internal|platform|group/i)
    expect(document.body.textContent).not.toMatch(/PAS delegated|member limit reached/)
  })
})

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'

// The rendered invitation flow must never show platform or implementation terms.
const PLATFORM_TERMS = /\bPAS\b|platform|delegat|internal group|app worker|proappstore/i

const { mockApp } = vi.hoisted(() => {
  const app = {
    auth: { user: { id: 'hawthorn-admin', login: 'hawthorn-admin' } as { id: string; login: string } | null },
    actions: { call: vi.fn() },
    invites: { create: vi.fn() },
  }
  return { mockApp: app }
})

vi.mock('@proappstore/sdk', () => ({
  initPro: () => mockApp,
  useAuth: () => ({ user: mockApp.auth.user, loading: false, signOut: vi.fn() }),
  ProShell: ({ children }: { children: React.ReactNode }) => children,
}))

import ClubAdmin from '../src/pages/ClubAdmin'

const ROWS: Record<string, unknown[]> = {
  list_managed_clubs: [{ id: 'hawthorn', name: 'Hawthorn Tennis Club', slug: 'hawthorn', role: 'admin' }],
  can_create_first_club: [{ eligible: 0 }],
  list_club_seasons: [],
  list_club_divisions: [],
  list_club_venues: [],
  list_club_teams: [{ id: 'senior-men', org_id: 'hawthorn', name: 'Senior Men', colour: null, division_id: 'div-1', division_name: 'Division 1', season_name: '2026' }],
  list_club_members: [],
  list_contact_details: [],
}

afterEach(() => cleanup())

describe('invitation copy', () => {
  it('lets a Hawthorn administrator create and read an invite link without any platform terms on screen', async () => {
    mockApp.actions.call.mockReset()
    mockApp.actions.call.mockImplementation(async (name: string) => ({ rows: ROWS[name] ?? [] }))
    mockApp.invites.create.mockReset()
    mockApp.invites.create.mockResolvedValue({ id: 'inv-1', code: 'HAWK42', link: 'https://tennis-clubs.proappstore.online/join/HAWK42', qr: '', role: 'member', group: 'team:senior-men', maxUses: 1, usedCount: 0, expiresAt: 0 })

    const { container } = render(<ClubAdmin app={mockApp as never} />)
    const teamSelect = await screen.findByLabelText('Invite team')
    await within(teamSelect).findByRole('option', { name: /Senior Men/ })
    fireEvent.change(teamSelect, { target: { value: 'senior-men' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create invite' }))

    const link = await screen.findByLabelText('Invite link') as HTMLInputElement
    expect(link.value).toMatch(/\/join\/HAWK42$/)
    expect(screen.getByText(/works once and expires after 7 days/)).toBeTruthy()
    expect(mockApp.invites.create).toHaveBeenCalledWith(expect.objectContaining({ uses: 1, expiresIn: '7d' }))
    expect(mockApp.invites.create.mock.calls[0][0]).not.toHaveProperty('role')

    await waitFor(() => expect(screen.getByText('Invite link created. Share it with the player; they join the team when they open it.')).toBeTruthy())
    // Text only: the link field's value holds the app's own address and is not copy.
    expect(container.textContent ?? '').not.toMatch(PLATFORM_TERMS)
    expect(container.textContent ?? '').toContain('Invite a team member')
  })

  it('shows Tennis Clubs wording, not the SDK error, when an invite cannot be created', async () => {
    mockApp.actions.call.mockReset()
    mockApp.actions.call.mockImplementation(async (name: string) => ({ rows: ROWS[name] ?? [] }))
    mockApp.invites.create.mockReset()
    mockApp.invites.create.mockRejectedValue(new Error('PAS delegated invite policy denied role player for group team:senior-men'))

    const { container } = render(<ClubAdmin app={mockApp as never} />)
    const teamSelect = await screen.findByLabelText('Invite team')
    await within(teamSelect).findByRole('option', { name: /Senior Men/ })
    fireEvent.change(teamSelect, { target: { value: 'senior-men' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create invite' }))

    expect(await screen.findByText('The invite link could not be created. Check that the team is still active, then try again.')).toBeTruthy()
    expect(container.textContent ?? '').not.toMatch(PLATFORM_TERMS)
  })

  it('lists the integration actions without platform terms', async () => {
    mockApp.actions.call.mockReset()
    mockApp.actions.call.mockImplementation(async (name: string) => ({ rows: ROWS[name] ?? [] }))
    const { container } = render(<ClubAdmin app={mockApp as never} />)
    await screen.findByText('Invite a team member')
    expect(container.textContent ?? '').toContain('Create a pending team membership for an invite link')
    expect(container.textContent ?? '').not.toMatch(PLATFORM_TERMS)
  })
})

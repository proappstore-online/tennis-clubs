import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ProAppStore } from '@proappstore/sdk'

type SyntheticUser = { id: string; login: string } | null
type SyntheticClub = { id: string; name: string; slug: string; role: string; createdBy?: string }

const { mockStore, mockApp } = vi.hoisted(() => {
  const store: {
    clubs: Array<{ id: string; name: string; slug: string; role: string }>
    user: { id: string; login: string } | null
    failNextCreate: boolean
    failNextBootstrap: boolean
    createAttempts: number
  } = { clubs: [], user: null, failNextCreate: false, failNextBootstrap: false, createAttempts: 0 }

  const app = {
    auth: { user: null as { id: string; login: string } | null },
    actions: { call: vi.fn() },
    invites: { create: vi.fn() },
  }

  return { mockStore: store, mockApp: app }
})

vi.mock('@proappstore/sdk', () => ({
  initPro: () => mockApp,
  useAuth: () => ({ user: mockStore.user, loading: false, signOut: vi.fn() }),
  ProShell: ({ children }: { children: React.ReactNode }) => children,
}))

import ClubAdmin from '../src/pages/ClubAdmin'

function resetStore(user: SyntheticUser = { id: 'user-1', login: 'testuser' }) {
  mockStore.clubs = []
  mockStore.user = user
  mockStore.failNextCreate = false
  mockStore.failNextBootstrap = false
  mockStore.createAttempts = 0
  mockApp.auth.user = user
  mockApp.actions.call.mockReset()
  mockApp.invites.create.mockReset()
  mockApp.actions.call.mockImplementation(async (name: string, values: Record<string, unknown> = {}) => {
    if (name === 'list_managed_clubs') {
      return { rows: mockStore.clubs.filter((club) => club.role === 'admin' || club.role === 'manager') }
    }
    if (name === 'list_my_clubs') return { rows: mockStore.clubs.filter((club) => club.role) }
    if (name === 'can_create_first_club') {
      const userId = mockApp.auth.user?.id
      if (!userId || mockStore.clubs.some((club) => club.role)) return { rows: [] }
      const pending = mockStore.clubs.find((club) => club.createdBy === userId)
      if (pending) return { rows: [{ eligible: 0, pending_org_id: pending.id, pending_club_name: pending.name }] }
      return { rows: mockStore.clubs.some((club) => club.createdBy) ? [] : [{ eligible: 1 }] }
    }
    if (name === 'create_club') {
      mockStore.createAttempts += 1
      if (mockStore.failNextCreate) {
        mockStore.failNextCreate = false
        throw new Error('Synthetic create failure. Please try again.')
      }
      if (mockStore.clubs.some((club) => club.name === values.name)) {
        throw new Error('A club with this name already exists in the synthetic test store.')
      }
      mockStore.clubs.push({
        id: String(values.id),
        name: String(values.name),
        slug: String(values.slug),
        role: '',
        createdBy: mockApp.auth.user?.id,
      })
      return { success: true }
    }
    if (name === 'bootstrap_club_admin') {
      const pending = mockStore.clubs.find((club) => club.id === values.org_id && club.createdBy === mockApp.auth.user?.id)
      if (!pending || mockStore.clubs.some((club) => club.role && club.id !== pending.id)) return { success: true }
      if (mockStore.failNextBootstrap) {
        mockStore.failNextBootstrap = false
        throw new Error('Synthetic bootstrap interruption. Resume setup to retry.')
      }
      pending.role = 'admin'
      return { success: true }
    }
    if (name === 'list_club_seasons' || name === 'list_club_divisions' || name === 'list_club_venues' || name === 'list_club_teams' || name === 'list_club_members') {
      return { rows: [] }
    }
    return { rows: [] }
  })
}

function renderClubAdmin() {
  return render(<ClubAdmin app={mockApp as unknown as ProAppStore} />)
}

function confirmNewClub() {
  const confirmation = screen.getByRole('checkbox', { name: 'I’m starting a new club, not restoring access to an existing club.' }) as HTMLInputElement
  if (!confirmation.checked) fireEvent.click(confirmation)
}

describe('real ClubAdmin first-club onboarding', () => {
  beforeEach(() => resetStore())
  afterEach(() => cleanup())

  it('lets a fresh signed-in user create a club and reach its setup view', async () => {
    renderClubAdmin()

    expect(await screen.findByRole('heading', { name: 'Create a new club' })).toBeTruthy()
    expect(screen.getByText('This account has no club memberships. If you already set up a club, sign in with the original Google account or ask a current club administrator to add you back. Creating a club here will not restore access to an existing club.')).toBeTruthy()
    fireEvent.change(screen.getByRole('textbox', { name: 'Club name' }), { target: { value: 'Synthetic Tennis Club' } })
    confirmNewClub()
    fireEvent.click(screen.getByRole('button', { name: 'Create your club' }))

    await waitFor(() => expect(mockApp.actions.call).toHaveBeenCalledWith('create_club', expect.objectContaining({ name: 'Synthetic Tennis Club' })))
    expect(mockApp.actions.call).toHaveBeenCalledWith('bootstrap_club_admin', expect.objectContaining({ org_id: expect.any(String), display_name: 'testuser' }))
    expect((await screen.findByRole('status')).textContent).toContain('Synthetic Tennis Club is ready. You are its administrator.')
    expect(await screen.findByRole('heading', { name: 'Season' })).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Venue' })).toBeTruthy()
  })

  it('does not offer first-club creation to an existing non-admin member', async () => {
    mockStore.clubs.push({ id: 'club-existing', name: 'Existing Club', slug: 'existing-club', role: 'player' })
    renderClubAdmin()

    expect(await screen.findByText('You belong to Existing Club, but don’t have club administration access. Ask a club administrator to make you a manager, convenor or administrator.')).toBeTruthy()
    expect(screen.queryByRole('heading', { name: 'Create a new club' })).toBeNull()
    expect(screen.queryByRole('textbox', { name: 'Club name' })).toBeNull()
  })

  it('tells an account whose earlier club access is inactive that it has no access, and offers no create or resume form', async () => {
    // The server returns no eligibility row when the account has an inactive membership or a club it created with no active access.
    resetStore()
    const backend = mockApp.actions.call.getMockImplementation()!
    mockApp.actions.call.mockImplementation(async (name: string, values: Record<string, unknown> = {}) => (name === 'can_create_first_club' ? { rows: [] } : backend(name, values)))
    renderClubAdmin()

    expect(await screen.findByText('You don’t have club administration access yet. Ask a club administrator to add you as a manager.')).toBeTruthy()
    expect(screen.queryByRole('heading', { name: 'Create a new club' })).toBeNull()
    expect(screen.queryByRole('textbox', { name: 'Club name' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Resume club setup' })).toBeNull()
    expect(mockApp.actions.call).not.toHaveBeenCalledWith('create_club', expect.anything())
  })

  it('shows actionable access feedback when the authenticated identity is missing', async () => {
    resetStore(null)
    renderClubAdmin()

    expect(await screen.findByText('You don’t have club administration access yet. Ask a club administrator to add you as a manager.')).toBeTruthy()
    expect(screen.queryByRole('heading', { name: 'Create a new club' })).toBeNull()
  })

  it('prevents submitting a blank club name', async () => {
    renderClubAdmin()
    await screen.findByRole('heading', { name: 'Create a new club' })

    const nameField = screen.getByRole('textbox', { name: 'Club name' }) as HTMLInputElement
    expect(nameField.required).toBe(true)
    fireEvent.submit(nameField.closest('form')!)

    expect(mockApp.actions.call).not.toHaveBeenCalledWith('create_club', expect.anything())
    expect(mockApp.actions.call).not.toHaveBeenCalledWith('bootstrap_club_admin', expect.anything())
  })

  it('requires an explicit acknowledgement before creating a new club', async () => {
    renderClubAdmin()
    await screen.findByRole('heading', { name: 'Create a new club' })
    fireEvent.change(screen.getByRole('textbox', { name: 'Club name' }), { target: { value: 'Deliberate Club' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create your club' }))

    expect(mockApp.actions.call).not.toHaveBeenCalledWith('create_club', expect.anything())
    confirmNewClub()
    fireEvent.click(screen.getByRole('button', { name: 'Create your club' }))
    await waitFor(() => expect(mockApp.actions.call).toHaveBeenCalledWith('create_club', expect.objectContaining({ name: 'Deliberate Club' })))
  })

  it('does not create a club when the form is submitted without the acknowledgement, even if browser validation is skipped', async () => {
    renderClubAdmin()
    await screen.findByRole('heading', { name: 'Create a new club' })
    const nameField = screen.getByRole('textbox', { name: 'Club name' })
    fireEvent.change(nameField, { target: { value: 'Unconfirmed Club' } })
    fireEvent.submit(nameField.closest('form')!)

    expect(mockApp.actions.call).not.toHaveBeenCalledWith('create_club', expect.anything())
    expect((await screen.findByRole('alert')).textContent).toContain('Confirm that you are starting a new club')
    expect(mockStore.clubs).toEqual([])
  })

  it('shows a failed create request, then permits retry without creating duplicates', async () => {
    mockStore.failNextCreate = true
    renderClubAdmin()
    await screen.findByRole('heading', { name: 'Create a new club' })
    fireEvent.change(screen.getByRole('textbox', { name: 'Club name' }), { target: { value: 'Retry Club' } })
    confirmNewClub()
    fireEvent.click(screen.getByRole('button', { name: 'Create your club' }))

    expect((await screen.findByRole('alert')).textContent).toContain('Synthetic create failure. Please try again.')
    expect(mockStore.clubs).toHaveLength(0)
    confirmNewClub()
    fireEvent.click(screen.getByRole('button', { name: 'Create your club' }))

    expect((await screen.findByRole('status')).textContent).toContain('Retry Club is ready. You are its administrator.')
    expect(mockStore.createAttempts).toBe(2)
    expect(mockStore.clubs).toHaveLength(1)
    expect(mockStore.clubs[0].name).toBe('Retry Club')
  })

  it('recovers persisted create success after bootstrap interruption and reloads to retry', async () => {
    mockStore.failNextBootstrap = true
    const first = renderClubAdmin()
    await screen.findByRole('heading', { name: 'Create a new club' })
    fireEvent.change(screen.getByRole('textbox', { name: 'Club name' }), { target: { value: 'Interrupted Club' } })
    confirmNewClub()
    fireEvent.click(screen.getByRole('button', { name: 'Create your club' }))

    expect((await screen.findByRole('alert')).textContent).toContain('Synthetic bootstrap interruption')
    expect(mockStore.clubs).toHaveLength(1)
    expect(mockStore.clubs[0].role).toBe('')
    expect(screen.queryByRole('combobox', { name: 'Club' })).toBeNull()
    first.unmount()

    renderClubAdmin()
    expect(await screen.findByRole('heading', { name: 'Finish setting up Interrupted Club' })).toBeTruthy()
    expect(screen.queryByRole('heading', { name: 'Create a new club' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Resume club setup' }))

    expect((await screen.findByRole('status')).textContent).toContain('Interrupted Club is ready. You are its administrator.')
    expect(mockStore.clubs).toHaveLength(1)
    expect(mockStore.clubs[0].role).toBe('admin')
    expect(mockStore.createAttempts).toBe(1)
  })

  it('does not offer or perform retry for another user’s pending club', async () => {
    mockStore.clubs.push({ id: 'pending-other', name: 'Other Pending Club', slug: 'other-pending', role: '', createdBy: 'original-owner' })
    renderClubAdmin()

    expect(await screen.findByText('You don’t have club administration access yet. Ask a club administrator to add you as a manager.')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Resume club setup' })).toBeNull()
    expect(mockApp.actions.call).not.toHaveBeenCalledWith('bootstrap_club_admin', expect.objectContaining({ org_id: 'pending-other' }))
  })

  it('shows a loading state while the managed-club request is pending', async () => {
    let release: ((value: { rows: SyntheticClub[] }) => void) | undefined
    mockApp.actions.call.mockImplementation((name: string) => {
      if (name === 'list_managed_clubs') return new Promise((resolve) => { release = resolve })
      if (name === 'can_create_first_club') return Promise.resolve({ rows: [{ eligible: 1 }] })
      return Promise.resolve({ rows: [] })
    })

    renderClubAdmin()
    expect(screen.getByRole('status').textContent).toContain('Loading club access')
    release?.({ rows: [] })
    expect(await screen.findByRole('heading', { name: 'Create a new club' })).toBeTruthy()
  })

  it('shows the created club after remounting from persistent synthetic store state', async () => {
    const first = renderClubAdmin()
    await screen.findByRole('heading', { name: 'Create a new club' })
    fireEvent.change(screen.getByRole('textbox', { name: 'Club name' }), { target: { value: 'Persistent Club' } })
    confirmNewClub()
    fireEvent.click(screen.getByRole('button', { name: 'Create your club' }))
    expect((await screen.findByRole('status')).textContent).toContain('Persistent Club is ready. You are its administrator.')

    first.unmount()
    renderClubAdmin()

    expect((await screen.findByRole('combobox', { name: 'Club' })).textContent).toContain('Persistent Club · admin')
    expect(screen.queryByRole('heading', { name: 'Create a new club' })).toBeNull()
  })
})

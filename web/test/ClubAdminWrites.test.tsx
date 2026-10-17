import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import ClubAdmin from '../src/pages/ClubAdmin'

afterEach(cleanup)

// Synthetic club: one club the caller administers, no first-club setup pending.
function renderWith(writes: Record<string, unknown>) {
  const call = vi.fn(async (name: string) => {
    if (name === 'list_managed_clubs') return { rows: [{ id: 'club-a', name: 'Club A', slug: 'club-a', role: 'admin' }] }
    if (name === 'can_create_first_club') return { rows: [{ eligible: 0, pending_org_id: null, pending_club_name: null }] }
    if (name in writes) return writes[name]
    return { rows: [] }
  })
  const app = { actions: { call }, invites: { create: vi.fn() }, auth: { user: null } }
  render(<ClubAdmin app={app as never} />)
  return { call, invitesCreate: app.invites.create }
}

describe('club administration writes', () => {
  it('does not report a refused season as created', async () => {
    const { call } = renderWith({ create_season: { changes: 0 } })
    const name = await screen.findByLabelText('Season name')
    fireEvent.change(name, { target: { value: '2026' } })
    fireEvent.change(screen.getByLabelText('Season starts on'), { target: { value: '2026-09-01' } })
    fireEvent.change(screen.getByLabelText('Season ends on'), { target: { value: '2026-03-01' } })
    fireEvent.submit(name.closest('form')!)
    expect(await screen.findByText('The change was not saved. Check the details and your club role, then try again.')).toBeTruthy()
    expect(screen.queryByText('Season created.')).toBeNull()
    expect(call).toHaveBeenCalledWith('record_audit_event', expect.objectContaining({ action: 'create_season', outcome: 'refused' }))
  })

  it('does not create an invite link for a team membership the server did not write', async () => {
    const { invitesCreate } = renderWith({ create_team_invite: { changes: 0 }, list_club_teams: { rows: [{ id: 'team-1', name: 'Seniors', division_name: null }] } })
    // The button stays disabled until the team list has loaded, so wait for the option first.
    await screen.findByRole('option', { name: 'Seniors' })
    fireEvent.change(screen.getByLabelText('Invite team'), { target: { value: 'team-1' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create invite' }))
    expect(await screen.findByText('The invite link could not be created. Check that the team is still active, then try again.')).toBeTruthy()
    expect(invitesCreate).not.toHaveBeenCalled()
    expect(screen.queryByLabelText('Invite link')).toBeNull()
  })
})

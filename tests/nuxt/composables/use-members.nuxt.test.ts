import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mockNuxtImport } from '@nuxt/test-utils/runtime'
import { useMembers } from '../../../app/composables/useMembers'

const success = vi.fn()
const error = vi.fn()

mockNuxtImport('useToast', () => () => ({
  success,
  error,
}))

describe('useMembers', () => {
  beforeEach(() => {
    success.mockReset()
    error.mockReset()
    useState('workspace-members').value = []
    useState('project-members').value = []
    useState('members-loading').value = false
  })

  it('loads workspace members and clears loading state', async () => {
    vi.stubGlobal('$fetch', vi.fn().mockResolvedValue([
      {
        id: 'member-1',
        role: 'owner',
        invited_email: null,
        invited_at: '2026-03-25T00:00:00.000Z',
        accepted_at: '2026-03-25T00:00:00.000Z',
        profiles: { id: 'user-1', display_name: 'Owner', email: 'owner@example.com', avatar_url: null },
      },
    ]))

    const members = useMembers()
    await members.fetchMembers('workspace-1')

    expect(members.loading.value).toBe(false)
    expect(members.members.value).toHaveLength(1)
    expect(members.members.value[0]?.role).toBe('owner')
  })

  it('invites a workspace member and refreshes the list', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce([
        {
          id: 'member-2',
          role: 'member',
          invited_email: 'editor@example.com',
          invited_at: '2026-03-25T00:00:00.000Z',
          accepted_at: null,
          profiles: null,
        },
      ])
    vi.stubGlobal('$fetch', fetchMock)

    const members = useMembers()
    const invited = await members.inviteMember('workspace-1', 'editor@example.com', 'member')

    expect(invited).toBe(true)
    expect(success).toHaveBeenCalledWith('Invited editor@example.com')
    expect(fetchMock).toHaveBeenNthCalledWith(1, '/api/workspaces/workspace-1/members', {
      method: 'POST',
      body: { email: 'editor@example.com', role: 'member' },
    })
    expect(fetchMock).toHaveBeenNthCalledWith(2, '/api/workspaces/workspace-1/members')
    expect(members.members.value[0]?.invited_email).toBe('editor@example.com')
  })

  it('assigns a project member and refreshes project access state', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce([
        {
          id: 'project-member-1',
          role: 'reviewer',
          specific_models: false,
          allowed_models: [],
          invited_email: 'reviewer@example.com',
          invited_at: '2026-03-25T00:00:00.000Z',
          accepted_at: null,
          profiles: null,
        },
      ])
    vi.stubGlobal('$fetch', fetchMock)

    const members = useMembers()
    const assigned = await members.assignProjectMember(
      'workspace-1',
      'project-1',
      'reviewer@example.com',
      'reviewer',
    )

    expect(assigned).toBe(true)
    expect(success).toHaveBeenCalledWith('Assigned reviewer@example.com as reviewer')
    expect(fetchMock).toHaveBeenNthCalledWith(2, '/api/workspaces/workspace-1/projects/project-1/members')
    expect(members.projectMembers.value[0]?.role).toBe('reviewer')
  })
})

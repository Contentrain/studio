import { beforeEach, describe, expect, it, vi } from 'vitest'

// Capture the exact row handed to PostgREST so we can assert the column set.
const { insertSpy, singleSpy } = vi.hoisted(() => ({
  insertSpy: vi.fn(),
  singleSpy: vi.fn(),
}))

vi.mock('../../server/providers/supabase-db/helpers', () => ({
  getAdmin: () => ({
    from: () => ({
      insert: (payload: unknown) => {
        insertSpy(payload)
        return { select: () => ({ single: singleSpy }) }
      },
    }),
  }),
  getUser: () => ({ from: () => ({}) }),
  PROJECT_MEMBER_SELECT: 'id, role, user_id',
}))

/**
 * Regression coverage for the project-invite 500.
 *
 * `project_members` is keyed by project_id only — the workspace is derived
 * via projects.workspace_id. The table has NO `workspace_id` column, so an
 * insert that included one made PostgREST reject the write with
 * "Could not find the 'workspace_id' column of 'project_members' in the
 * schema cache" (HTTP 500). That silently broke every Project Access
 * assignment: the invitee landed in the workspace but never got project
 * access. Guard the insert payload's column set.
 */
describe('createProjectMember insert payload', () => {
  beforeEach(() => {
    insertSpy.mockReset()
    singleSpy.mockReset()
    singleSpy.mockResolvedValue({ data: { id: 'pm1', role: 'editor', user_id: 'u1' }, error: null })
    vi.stubGlobal('createError', (input: { statusCode: number, message: string }) => new Error(input.message))
  })

  it('does not write a non-existent workspace_id column', async () => {
    const { projectMethods } = await import('../../server/providers/supabase-db/projects')

    await projectMethods().createProjectMember({
      projectId: 'p1',
      workspaceId: 'w1',
      userId: 'u1',
      role: 'editor',
      invitedEmail: 'invitee@example.com',
      specificModels: false,
      allowedModels: [],
    })

    expect(insertSpy).toHaveBeenCalledTimes(1)
    const payload = insertSpy.mock.calls[0]![0] as Record<string, unknown>
    expect(payload).not.toHaveProperty('workspace_id')
    expect(Object.keys(payload).toSorted()).toEqual(
      ['allowed_models', 'invited_email', 'project_id', 'role', 'specific_models', 'user_id'],
    )
    expect(payload.project_id).toBe('p1')
    expect(payload.user_id).toBe('u1')
  })
})

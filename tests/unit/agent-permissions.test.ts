import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveAgentPermissions } from '../../server/utils/agent-permissions'

interface QueryState {
  table: string
  filters: Record<string, unknown>
}

function createSupabaseClient(rows: {
  workspaceMember?: { role: 'owner' | 'admin' | 'member' } | null
  projectMember?: { role: 'editor' | 'reviewer' | 'viewer', specific_models?: boolean, allowed_models?: string[] } | null
  workspace?: { plan?: string | null } | null
}) {
  return {
    from(table: string) {
      const state: QueryState = { table, filters: {} }

      return {
        select() {
          return this
        },
        eq(key: string, value: unknown) {
          state.filters[key] = value
          return this
        },
        async single() {
          if (state.table === 'workspace_members') {
            return { data: rows.workspaceMember ?? null }
          }
          if (state.table === 'project_members') {
            return { data: rows.projectMember ?? null }
          }
          if (state.table === 'workspaces') {
            return { data: rows.workspace ?? null }
          }
          return { data: null }
        },
      }
    },
  }
}

describe('resolveAgentPermissions', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('returns full tool access for workspace owners and admins', async () => {
    vi.stubGlobal('useSupabaseUserClient', () => createSupabaseClient({
      workspaceMember: { role: 'owner' },
    }))

    const permissions = await resolveAgentPermissions('user-1', 'ws-1', 'project-1', 'token')

    expect(permissions.workspaceRole).toBe('owner')
    expect(permissions.availableTools).toContain('save_model')
    expect(permissions.availableTools).toContain('merge_branch')
    expect(permissions.specificModels).toBe(false)
  })

  it('returns no tools when a workspace member is not assigned to the project', async () => {
    vi.stubGlobal('useSupabaseUserClient', () => createSupabaseClient({
      workspaceMember: { role: 'member' },
      projectMember: null,
    }))

    const permissions = await resolveAgentPermissions('user-1', 'ws-1', 'project-1', 'token')

    expect(permissions.workspaceRole).toBe('member')
    expect(permissions.projectRole).toBeNull()
    expect(permissions.availableTools).toEqual([])
  })

  it('degrades reviewer and disables specificModels on free plan', async () => {
    vi.stubGlobal('useSupabaseUserClient', () => createSupabaseClient({
      workspaceMember: { role: 'member' },
      projectMember: {
        role: 'reviewer',
        specific_models: true,
        allowed_models: ['faq', 'docs'],
      },
      workspace: { plan: 'free' },
    }))

    const permissions = await resolveAgentPermissions('user-1', 'ws-1', 'project-1', 'token')

    expect(permissions.projectRole).toBe('editor')
    expect(permissions.availableTools).toContain('save_content')
    expect(permissions.availableTools).not.toContain('merge_branch')
    expect(permissions.specificModels).toBe(false)
    expect(permissions.allowedModels).toEqual([])
  })

  it('keeps advanced role and allowed models on supported plans', async () => {
    vi.stubGlobal('useSupabaseUserClient', () => createSupabaseClient({
      workspaceMember: { role: 'member' },
      projectMember: {
        role: 'reviewer',
        specific_models: true,
        allowed_models: ['faq', 'docs'],
      },
      workspace: { plan: 'pro' },
    }))

    const permissions = await resolveAgentPermissions('user-1', 'ws-1', 'project-1', 'token')

    expect(permissions.projectRole).toBe('reviewer')
    expect(permissions.availableTools).toContain('merge_branch')
    expect(permissions.availableTools).not.toContain('save_model')
    expect(permissions.specificModels).toBe(true)
    expect(permissions.allowedModels).toEqual(['faq', 'docs'])
  })
})

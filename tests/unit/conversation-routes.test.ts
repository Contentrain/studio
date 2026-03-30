import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

function createErrorLike(input: { statusCode: number, message: string }) {
  return Object.assign(new Error(input.message), input)
}

function createClient(overrides: {
  conversationsData?: unknown
  messagesData?: unknown
  deleteError?: { message: string } | null
  conversationExists?: boolean
}) {
  return {
    from(table: string) {
      if (table === 'conversations') {
        return {
          select: vi.fn(() => ({
            eq: vi.fn(() => ({
              eq: vi.fn(() => ({
                order: vi.fn(() => ({
                  limit: vi.fn().mockResolvedValue({ data: overrides.conversationsData ?? [] }),
                })),
                eq: vi.fn(() => ({
                  single: vi.fn().mockResolvedValue({ data: overrides.conversationExists === false ? null : { id: 'conv-1' } }),
                })),
                single: vi.fn().mockResolvedValue({ data: overrides.conversationExists === false ? null : { id: 'conv-1' } }),
              })),
            })),
          })),
          delete: vi.fn(() => ({
            eq: vi.fn(() => ({
              eq: vi.fn(() => ({
                eq: vi.fn().mockResolvedValue({ error: overrides.deleteError ?? null }),
              })),
            })),
          })),
        }
      }

      if (table === 'messages') {
        return {
          select: vi.fn(() => ({
            eq: vi.fn(() => ({
              order: vi.fn(() => ({
                limit: vi.fn().mockResolvedValue({ data: overrides.messagesData ?? [], error: null }),
              })),
            })),
          })),
        }
      }

      return {}
    },
  }
}

describe('conversation routes', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
    vi.stubGlobal('createError', createErrorLike)
    vi.stubGlobal('requireAuth', vi.fn().mockReturnValue({
      user: { id: 'user-1' },
      accessToken: 'token-1',
    }))
    vi.stubGlobal('useDatabaseProvider', vi.fn(() => ({
      getUserClient: vi.fn((accessToken: string) => {
        const userClient = (globalThis as typeof globalThis & {
          useSupabaseUserClient?: (token: string) => unknown
        }).useSupabaseUserClient
        return typeof userClient === 'function' ? userClient(accessToken) : {}
      }),
    })))
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('lists user conversations for a project', async () => {
    vi.stubGlobal('getRouterParam', vi.fn((_: unknown, key: string) => {
      if (key === 'workspaceId') return 'workspace-1'
      if (key === 'projectId') return 'project-1'
      return undefined
    }))
    vi.stubGlobal('useSupabaseUserClient', vi.fn().mockReturnValue(createClient({
      conversationsData: [{ id: 'conv-1', title: 'Hello', created_at: 'x', updated_at: 'y' }],
    })))

    const handler = (await import('../../server/api/workspaces/[workspaceId]/projects/[projectId]/conversations/index.get')).default
    const result = await handler({} as never)

    expect(result).toEqual([{ id: 'conv-1', title: 'Hello', created_at: 'x', updated_at: 'y' }])
  })

  it('loads conversation messages only when the conversation belongs to the user and project', async () => {
    vi.stubGlobal('getRouterParam', vi.fn((_: unknown, key: string) => {
      if (key === 'conversationId') return 'conv-1'
      if (key === 'projectId') return 'project-1'
      return 'workspace-1'
    }))
    vi.stubGlobal('useSupabaseUserClient', vi.fn().mockReturnValue(createClient({
      conversationExists: true,
      messagesData: [{ id: 'msg-1', role: 'user', content: 'Hello', tool_calls: null, model: null, created_at: 'now' }],
    })))

    const handler = (await import('../../server/api/workspaces/[workspaceId]/projects/[projectId]/conversations/[conversationId]/messages.get')).default
    const result = await handler({} as never)

    expect(result).toEqual([{ id: 'msg-1', role: 'user', content: 'Hello', tool_calls: null, model: null, created_at: 'now' }])
  })

  it('returns 404 for foreign or missing conversations', async () => {
    vi.stubGlobal('getRouterParam', vi.fn((_: unknown, key: string) => {
      if (key === 'conversationId') return 'conv-1'
      if (key === 'projectId') return 'project-1'
      return 'workspace-1'
    }))
    vi.stubGlobal('useSupabaseUserClient', vi.fn().mockReturnValue(createClient({
      conversationExists: false,
    })))

    const handler = (await import('../../server/api/workspaces/[workspaceId]/projects/[projectId]/conversations/[conversationId]/messages.get')).default

    await expect(handler({} as never)).rejects.toMatchObject({
      statusCode: 404,
    })
  })

  it('deletes a conversation scoped to the current user and project', async () => {
    vi.stubGlobal('getRouterParam', vi.fn((_: unknown, key: string) => {
      if (key === 'conversationId') return 'conv-1'
      if (key === 'projectId') return 'project-1'
      return 'workspace-1'
    }))
    vi.stubGlobal('useSupabaseUserClient', vi.fn().mockReturnValue(createClient({})))

    const handler = (await import('../../server/api/workspaces/[workspaceId]/projects/[projectId]/conversations/[conversationId].delete')).default
    const result = await handler({} as never)

    expect(result).toEqual({ deleted: true })
  })
})

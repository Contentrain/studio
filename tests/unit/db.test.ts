import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

async function loadDbModule() {
  return import('../../server/utils/db')
}

function createErrorLike(input: { statusCode: number, message: string }) {
  return Object.assign(new Error(input.message), input)
}

describe('db helpers', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.stubGlobal('createError', createErrorLike)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('resolves project context and normalizes the content root', async () => {
    const singleProject = vi.fn().mockResolvedValue({
      data: {
        id: 'project-1',
        repo_full_name: 'contentrain/studio',
        content_root: '/apps/web/',
        workspace_id: 'workspace-1',
        default_branch: 'main',
        detected_stack: 'nuxt',
        status: 'active',
      },
    })
    const singleWorkspace = vi.fn().mockResolvedValue({
      data: {
        id: 'workspace-1',
        github_installation_id: 123,
        plan: 'pro',
      },
    })
    const client = {
      from: vi.fn((table: string) => ({
        select: vi.fn(() => ({
          eq: vi.fn((key: string) => {
            if (table === 'projects' && key === 'workspace_id') {
              return { single: singleProject }
            }
            if (table === 'workspaces') {
              return { single: singleWorkspace }
            }
            return {
              eq: vi.fn(() => ({ single: singleProject })),
              single: singleProject,
            }
          }),
        })),
      })),
    }
    const git = { provider: 'git' }

    vi.stubGlobal('useGitProvider', vi.fn().mockReturnValue(git))

    const { resolveProjectContext } = await loadDbModule()
    const result = await resolveProjectContext(client as never, 'workspace-1', 'project-1')

    expect(result.contentRoot).toBe('apps/web')
    expect(result.git).toBe(git)
    expect(result.workspace.id).toBe('workspace-1')
  })

  it('creates conversations with titles capped at 100 characters', async () => {
    const single = vi.fn().mockResolvedValue({ data: { id: 'conv-1' } })
    const insert = vi.fn(() => ({
      select: vi.fn(() => ({ single })),
    }))
    const client = {
      from: vi.fn(() => ({
        insert,
      })),
    }

    const { createConversation } = await loadDbModule()
    const id = await createConversation(client as never, 'project-1', 'user-1', 'x'.repeat(140))

    expect(id).toBe('conv-1')
    expect(insert).toHaveBeenCalledWith(expect.objectContaining({
      title: 'x'.repeat(100),
    }))
  })

  it('loads conversation history in chronological order with a limit', async () => {
    const limit = vi.fn().mockResolvedValue({ data: [{ role: 'user', content: 'Hello', tool_calls: null }] })
    const order = vi.fn(() => ({ limit }))
    const eq = vi.fn(() => ({ order }))
    const client = {
      from: vi.fn(() => ({
        select: vi.fn(() => ({
          eq,
        })),
      })),
    }

    const { loadConversationHistory } = await loadDbModule()
    const rows = await loadConversationHistory(client as never, 'conv-1', 10)

    expect(rows).toEqual([{ role: 'user', content: 'Hello', tool_calls: null }])
  })

  it('increments existing usage rows when saving chat results', async () => {
    const messagesInsert = vi.fn().mockResolvedValue({})
    const usageSingle = vi.fn().mockResolvedValue({
      data: {
        id: 'usage-1',
        message_count: 2,
        input_tokens: 10,
        output_tokens: 5,
      },
    })
    const usageUpdateEq = vi.fn().mockResolvedValue({})
    const conversationsUpdateEq = vi.fn().mockResolvedValue({})

    const admin = {
      from: vi.fn((table: string) => {
        if (table === 'messages') {
          return {
            insert: messagesInsert,
          }
        }
        if (table === 'agent_usage') {
          return {
            select: vi.fn(() => ({
              eq: vi.fn(() => ({
                eq: vi.fn(() => ({
                  eq: vi.fn(() => ({
                    eq: vi.fn(() => ({ single: usageSingle })),
                    single: usageSingle,
                  })),
                })),
              })),
            })),
            update: vi.fn(() => ({
              eq: usageUpdateEq,
            })),
          }
        }
        if (table === 'conversations') {
          return {
            update: vi.fn(() => ({
              eq: conversationsUpdateEq,
            })),
          }
        }
        return {}
      }),
    }

    const { saveChatResult } = await loadDbModule()
    await saveChatResult(
      admin as never,
      'conv-1',
      'Hello',
      'World',
      [{ type: 'text', text: 'World' }],
      'claude-sonnet-4-20250514',
      7,
      3,
      'workspace-1',
      'user-1',
      'studio',
    )

    expect(messagesInsert).toHaveBeenCalledTimes(2)
    expect(usageUpdateEq).toHaveBeenCalledWith('id', 'usage-1')
    expect(conversationsUpdateEq).toHaveBeenCalledWith('id', 'conv-1')
  })

  it('inserts a fresh usage row when none exists', async () => {
    const usageInsert = vi.fn().mockResolvedValue({})
    const admin = {
      from: vi.fn((table: string) => {
        if (table === 'messages') {
          return {
            insert: vi.fn().mockResolvedValue({}),
          }
        }
        if (table === 'agent_usage') {
          return {
            select: vi.fn(() => ({
              eq: vi.fn(() => ({
                eq: vi.fn(() => ({
                  eq: vi.fn(() => ({
                    eq: vi.fn(() => ({ single: vi.fn().mockResolvedValue({ data: null }) })),
                    single: vi.fn().mockResolvedValue({ data: null }),
                  })),
                })),
              })),
            })),
            insert: usageInsert,
          }
        }
        if (table === 'conversations') {
          return {
            update: vi.fn(() => ({
              eq: vi.fn().mockResolvedValue({}),
            })),
          }
        }
        return {}
      }),
    }

    const { saveChatResult } = await loadDbModule()
    await saveChatResult(
      admin as never,
      'conv-1',
      'Hello',
      '',
      [],
      'claude-haiku-4-5-20251001',
      4,
      2,
      'workspace-1',
      'user-1',
      'byoa',
    )

    expect(usageInsert).toHaveBeenCalledWith(expect.objectContaining({
      workspace_id: 'workspace-1',
      user_id: 'user-1',
      source: 'byoa',
      message_count: 1,
      input_tokens: 4,
      output_tokens: 2,
    }))
  })
})

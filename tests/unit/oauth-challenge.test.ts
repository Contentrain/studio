import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mcpInsufficientScope, mcpUnauthorized } from '../../server/utils/oauth-server/challenge'

/**
 * Exact WWW-Authenticate strings — Claude/ChatGPT parse these to drive the
 * Connect card (401 invalid_token + resource_metadata) and the step-up
 * re-consent (403 insufficient_scope). Header shape drift breaks auth UX
 * silently, so the strings are pinned literally.
 */

const headers = new Map<string, string>()

vi.mock('h3', async () => {
  const actual = await vi.importActual<typeof import('h3')>('h3')
  return {
    ...actual,
    setResponseHeader: (_event: unknown, name: string, value: string) => {
      headers.set(name, value)
    },
  }
})

describe('MCP auth challenges', () => {
  beforeEach(() => {
    headers.clear()
    vi.stubGlobal('useRuntimeConfig', () => ({ public: { siteUrl: 'https://studio.example' } }))
    vi.stubGlobal('createError', (input: { statusCode: number, message: string }) => {
      const err = new Error(input.message) as Error & { statusCode: number }
      err.statusCode = input.statusCode
      return err
    })
  })

  it('401 challenge carries invalid_token + resource_metadata + the minimum scope hint', () => {
    expect(() => mcpUnauthorized({} as never)).toThrowError(
      expect.objectContaining({ statusCode: 401 }),
    )

    expect(headers.get('WWW-Authenticate')).toBe(
      'Bearer error="invalid_token", error_description="Authentication required", '
      + 'resource_metadata="https://studio.example/.well-known/oauth-protected-resource/api/mcp/remote", '
      + 'scope="content:read content:write project:metadata"',
    )
  })

  it('403 step-up preserves current scopes and adds the required one, in canonical order', () => {
    expect(() => mcpInsufficientScope({} as never, 'content:write', 'content:read project:metadata offline_access'))
      .toThrowError(expect.objectContaining({ statusCode: 403 }))

    expect(headers.get('WWW-Authenticate')).toBe(
      'Bearer error="insufficient_scope", '
      + 'scope="content:read content:write project:metadata offline_access", '
      + 'resource_metadata="https://studio.example/.well-known/oauth-protected-resource/api/mcp/remote"',
    )
  })

  it('403 step-up does not invent scopes the grant never had', () => {
    expect(() => mcpInsufficientScope({} as never, 'content:read', 'project:metadata')).toThrow()
    expect(headers.get('WWW-Authenticate')).toContain('scope="content:read project:metadata"')
    expect(headers.get('WWW-Authenticate')).not.toContain('content:write')
  })
})

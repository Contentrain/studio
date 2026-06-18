import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Scope model for CDN/media Bearer keys (migration 010). `requireScope`
 * is the enforcement primitive the public media API leans on, and
 * `validateCDNKey` must surface the key's scopes (defaulting to delivery
 * so pre-migration keys keep serving).
 */
describe('CDN key scopes', () => {
  beforeEach(() => {
    vi.stubGlobal('createError', (input: { statusCode: number, message: string }) => {
      const err = new Error(input.message) as Error & { statusCode: number }
      err.statusCode = input.statusCode
      return err
    })
    vi.stubGlobal('errorMessage', (key: string) => key)
  })

  it('requireScope passes when the scope is present', async () => {
    const { requireScope } = await import('../../server/utils/cdn-keys')
    expect(() => requireScope(['delivery', 'media:write'], 'media:write')).not.toThrow()
  })

  it('requireScope throws 403 when the scope is missing', async () => {
    const { requireScope } = await import('../../server/utils/cdn-keys')
    expect(() => requireScope(['delivery'], 'media:write')).toThrowError(/cdn\.scope_insufficient/)
  })

  it('validateCDNKey surfaces the key scopes', async () => {
    vi.stubGlobal('useDatabaseProvider', () => ({
      validateCDNKeyHash: vi.fn().mockResolvedValue({
        id: 'key-1',
        project_id: 'proj-1',
        rate_limit_per_hour: 100,
        allowed_origins: [],
        scopes: ['media:read', 'media:write'],
      }),
      updateCDNKeyLastUsed: vi.fn().mockResolvedValue(undefined),
    }))
    const { validateCDNKey } = await import('../../server/utils/cdn-keys')

    const result = await validateCDNKey('Bearer crn_live_test')

    expect(result.projectId).toBe('proj-1')
    expect(result.scopes).toEqual(['media:read', 'media:write'])
  })

  it('validateCDNKey defaults scopes to delivery for legacy keys', async () => {
    vi.stubGlobal('useDatabaseProvider', () => ({
      validateCDNKeyHash: vi.fn().mockResolvedValue({
        id: 'key-2',
        project_id: 'proj-1',
        rate_limit_per_hour: 100,
        allowed_origins: [],
        // no `scopes` — simulates a pre-migration row
      }),
      updateCDNKeyLastUsed: vi.fn().mockResolvedValue(undefined),
    }))
    const { validateCDNKey } = await import('../../server/utils/cdn-keys')

    const result = await validateCDNKey('Bearer crn_live_test')

    expect(result.scopes).toEqual(['delivery'])
  })
})

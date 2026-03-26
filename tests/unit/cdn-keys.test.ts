import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { generateCDNKey, hashCDNKey } from '../../server/utils/cdn-keys'

async function loadCDNKeysModule() {
  return import('../../server/utils/cdn-keys')
}

describe('cdn keys', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.stubGlobal('createError', ({ statusCode, message }: { statusCode: number, message: string }) =>
      Object.assign(new Error(message), { statusCode, message }),
    )
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('generates prefixed keys and deterministic hashes', () => {
    const { key, keyHash, keyPrefix } = generateCDNKey()

    expect(key.startsWith('crn_live_')).toBe(true)
    expect(keyPrefix).toBe(key.slice(0, 16))
    expect(keyHash).toBe(hashCDNKey(key))
  })

  it('rejects missing bearer tokens before touching the database', async () => {
    vi.stubGlobal('useSupabaseAdmin', vi.fn())

    const { validateCDNKey } = await loadCDNKeysModule()

    await expect(validateCDNKey(undefined)).rejects.toMatchObject({
      statusCode: 401,
    })
  })

  it('rejects expired api keys', async () => {
    const single = vi.fn().mockResolvedValue({
      data: {
        id: 'key-1',
        project_id: 'project-1',
        expires_at: '2020-01-01T00:00:00.000Z',
      },
    })
    const eq = vi.fn(() => ({ is: vi.fn(() => ({ single })) }))

    vi.stubGlobal('useSupabaseAdmin', vi.fn().mockReturnValue({
      from: vi.fn(() => ({
        select: vi.fn(() => ({
          eq,
        })),
      })),
    }))

    const { validateCDNKey } = await loadCDNKeysModule()

    await expect(validateCDNKey('Bearer crn_live_example')).rejects.toMatchObject({
      statusCode: 401,
    })
  })

  it('returns project info and updates last_used_at for valid api keys', async () => {
    const updateEq = vi.fn().mockResolvedValue({ error: null })
    const single = vi.fn().mockResolvedValue({
      data: {
        id: 'key-1',
        project_id: 'project-1',
        rate_limit_per_hour: 500,
        allowed_origins: ['https://app.example.com'],
        revoked_at: null,
        expires_at: null,
      },
    })
    const from = vi.fn((table: string) => {
      if (table === 'cdn_api_keys') {
        return {
          select: vi.fn(() => ({
            eq: vi.fn(() => ({
              is: vi.fn(() => ({ single })),
            })),
          })),
          update: vi.fn(() => ({
            eq: updateEq,
          })),
        }
      }

      return {}
    })

    vi.stubGlobal('useSupabaseAdmin', vi.fn().mockReturnValue({ from }))

    const { validateCDNKey } = await loadCDNKeysModule()
    const result = await validateCDNKey('Bearer crn_live_example')

    expect(result).toEqual({
      projectId: 'project-1',
      keyId: 'key-1',
      rateLimitPerHour: 500,
      allowedOrigins: ['https://app.example.com'],
    })
    expect(updateEq).toHaveBeenCalledWith('id', 'key-1')
  })
})

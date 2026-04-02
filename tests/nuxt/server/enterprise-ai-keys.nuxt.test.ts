import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { decryptApiKey, encryptApiKey } from '../../../server/utils/encryption'

const useDatabaseProvider = vi.fn()

vi.mock('../../../server/utils/providers', () => ({
  useDatabaseProvider,
}))

async function loadAiKeysModule() {
  return import('../../../ee/enterprise/ai-keys')
}

describe('enterprise ai key resolution', () => {
  beforeEach(() => {
    vi.resetModules()
    useDatabaseProvider.mockReset()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('re-encrypts BYOA keys when they are decrypted with the previous session secret', async () => {
    const previousSecret = 'a'.repeat(32)
    const currentSecret = 'b'.repeat(32)
    const plaintext = 'sk-ant-api03-abcdef'
    const encryptedWithPrevious = encryptApiKey(plaintext, previousSecret)
    const upsertUserAIKey = vi.fn().mockResolvedValue({
      id: 'key-1',
      provider: 'anthropic',
      key_hint: '...cdef',
    })

    useDatabaseProvider.mockReturnValue({
      getBYOAKey: vi.fn().mockResolvedValue(encryptedWithPrevious),
      upsertUserAIKey,
    })

    const { resolveEnterpriseChatApiKey } = await loadAiKeysModule()
    const resolved = await resolveEnterpriseChatApiKey({
      workspaceId: 'workspace-1',
      userId: 'user-1',
      accessToken: 'token-1',
      plan: 'pro',
      sessionSecret: currentSecret,
      previousSessionSecret: previousSecret,
    })

    expect(resolved).toEqual({
      apiKey: plaintext,
      usageSource: 'byoa',
    })
    expect(upsertUserAIKey).toHaveBeenCalledWith('token-1', expect.objectContaining({
      workspaceId: 'workspace-1',
      userId: 'user-1',
      provider: 'anthropic',
      keyHint: '...cdef',
    }))

    const reEncrypted = upsertUserAIKey.mock.calls[0]?.[1]?.encryptedKey
    expect(typeof reEncrypted).toBe('string')
    expect(reEncrypted).not.toBe(encryptedWithPrevious)
    expect(decryptApiKey(reEncrypted as string, currentSecret)).toBe(plaintext)
  })
})

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const providerMocks = vi.hoisted(() => ({
  createSupabaseAuthProvider: vi.fn(() => ({ kind: 'auth-provider' })),
  createStudioGitProvider: vi.fn((options: unknown) => ({ kind: 'git-provider', options })),
  createAnthropicProvider: vi.fn(() => ({ kind: 'ai-provider' })),
  createSharpMediaProvider: vi.fn((options: unknown) => ({ kind: 'media-provider', options })),
}))

vi.mock('../../server/providers/supabase-auth', () => ({
  createSupabaseAuthProvider: providerMocks.createSupabaseAuthProvider,
}))

vi.mock('../../server/providers/git', () => ({
  createStudioGitProvider: providerMocks.createStudioGitProvider,
}))

vi.mock('../../server/providers/anthropic-ai', () => ({
  createAnthropicProvider: providerMocks.createAnthropicProvider,
}))

vi.mock('../../ee/media/sharp-processor', () => ({
  createSharpMediaProvider: providerMocks.createSharpMediaProvider,
}))

describe('provider resolver utilities', () => {
  beforeEach(() => {
    vi.resetModules()
    providerMocks.createSupabaseAuthProvider.mockClear()
    providerMocks.createStudioGitProvider.mockClear()
    providerMocks.createAnthropicProvider.mockClear()
    providerMocks.createSharpMediaProvider.mockClear()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('returns singleton auth and AI providers', async () => {
    const { useAuthProvider, useAIProvider } = await import('../../server/utils/providers')

    expect(useAuthProvider()).toBe(useAuthProvider())
    expect(useAIProvider()).toBe(useAIProvider())
    expect(providerMocks.createSupabaseAuthProvider).toHaveBeenCalledTimes(1)
    expect(providerMocks.createAnthropicProvider).toHaveBeenCalledTimes(1)
  })

  it('creates a fresh git provider per call via createStudioGitProvider', async () => {
    const { useGitProvider } = await import('../../server/utils/providers')

    const provider = useGitProvider({
      installationId: 42,
      owner: 'contentrain',
      repo: 'studio',
    })

    expect(provider).toEqual({
      kind: 'git-provider',
      options: {
        installationId: 42,
        owner: 'contentrain',
        repo: 'studio',
      },
    })
    expect(providerMocks.createStudioGitProvider).toHaveBeenCalledTimes(1)
  })

  it('returns null CDN/media providers when object storage is not configured', async () => {
    vi.stubGlobal('useRuntimeConfig', () => ({
      github: {
        appId: 'app-1',
        privateKey: Buffer.from('pem-key', 'utf-8').toString('base64'),
      },
      cdn: {
        r2AccountId: '',
        r2AccessKeyId: '',
        r2SecretAccessKey: '',
        r2Bucket: '',
      },
    }))

    const { useCDNProvider, useMediaProvider } = await import('../../server/utils/providers')

    expect(useCDNProvider()).toBeNull()
    expect(useMediaProvider()).toBeNull()
  })
})

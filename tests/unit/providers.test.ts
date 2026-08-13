import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const providerMocks = vi.hoisted(() => ({
  createSupabaseAuthProvider: vi.fn(() => ({ kind: 'auth-provider' })),
  createSupabaseDatabaseProvider: vi.fn(() => ({ kind: 'database-provider' })),
  createManagedAuthProvider: vi.fn(() => ({ kind: 'managed-auth-provider' })),
  createPostgresDatabaseProvider: vi.fn(() => ({ kind: 'postgres-database-provider' })),
  configurePostgresDb: vi.fn(),
  createStudioGitProvider: vi.fn((options: unknown) => ({ kind: 'git-provider', options })),
  createAnthropicProvider: vi.fn(() => ({ kind: 'ai-provider' })),
  createSharpMediaProvider: vi.fn((options: unknown) => ({ kind: 'media-provider', options })),
}))

vi.mock('../../server/providers/supabase-auth', () => ({
  createSupabaseAuthProvider: providerMocks.createSupabaseAuthProvider,
}))

vi.mock('../../server/providers/supabase-db', () => ({
  createSupabaseDatabaseProvider: providerMocks.createSupabaseDatabaseProvider,
}))

vi.mock('../../server/providers/managed-auth', () => ({
  createManagedAuthProvider: providerMocks.createManagedAuthProvider,
}))

vi.mock('../../server/providers/postgres-db', () => ({
  createPostgresDatabaseProvider: providerMocks.createPostgresDatabaseProvider,
  configurePostgresDb: providerMocks.configurePostgresDb,
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
  // Pay the module-graph transform once, outside any test's clock. Every test
  // re-imports the resolver (`vi.resetModules()` is what makes the singleton
  // assertions meaningful), and the first import has to transform the whole
  // provider graph — which intermittently ran past the 5s default on a busy
  // machine and failed a test that asserts nothing about speed.
  beforeAll(async () => {
    await import('../../server/utils/providers')
  }, 30_000)

  beforeEach(() => {
    vi.resetModules()
    providerMocks.createSupabaseAuthProvider.mockClear()
    providerMocks.createSupabaseDatabaseProvider.mockClear()
    providerMocks.createManagedAuthProvider.mockClear()
    providerMocks.createPostgresDatabaseProvider.mockClear()
    providerMocks.configurePostgresDb.mockClear()
    providerMocks.createStudioGitProvider.mockClear()
    providerMocks.createAnthropicProvider.mockClear()
    providerMocks.createSharpMediaProvider.mockClear()
    // The auth/db factories read the provider selectors off the runtime
    // config — default to an empty config (= supabase pair) unless a test
    // stubs its own.
    vi.stubGlobal('useRuntimeConfig', () => ({}))
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

  it('selects the Supabase database provider by default and caches the singleton', async () => {
    const { useDatabaseProvider } = await import('../../server/utils/providers')

    expect(useDatabaseProvider()).toBe(useDatabaseProvider())
    expect(providerMocks.createSupabaseDatabaseProvider).toHaveBeenCalledTimes(1)
  })

  it('selects the Supabase pair when the selectors are set explicitly', async () => {
    vi.stubGlobal('useRuntimeConfig', () => ({ authProvider: 'supabase', databaseProvider: 'supabase' }))

    const { useAuthProvider, useDatabaseProvider } = await import('../../server/utils/providers')

    expect(useAuthProvider()).toEqual({ kind: 'auth-provider' })
    expect(useDatabaseProvider()).toEqual({ kind: 'database-provider' })
  })

  it('selects the managed/postgres pair and configures the pg client from runtime config', async () => {
    vi.stubGlobal('useRuntimeConfig', () => ({
      authProvider: 'managed',
      databaseProvider: 'postgres',
      postgres: { url: 'postgres://user:pw@host:5432/db' },
      authJwtSecret: 'j'.repeat(32),
    }))

    const { useAuthProvider, useDatabaseProvider } = await import('../../server/utils/providers')

    expect(useAuthProvider()).toEqual({ kind: 'managed-auth-provider' })
    expect(useDatabaseProvider()).toEqual({ kind: 'postgres-database-provider' })
    expect(useDatabaseProvider()).toBe(useDatabaseProvider())
    expect(providerMocks.configurePostgresDb).toHaveBeenCalledWith({
      url: 'postgres://user:pw@host:5432/db',
      authJwtSecret: 'j'.repeat(32),
    })
    expect(providerMocks.createSupabaseAuthProvider).not.toHaveBeenCalled()
    expect(providerMocks.createSupabaseDatabaseProvider).not.toHaveBeenCalled()
  })
})

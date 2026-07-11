import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/** Minimal JWT-shaped token whose payload carries the given role claim. */
function jwtWithRole(role: string) {
  const payload = Buffer.from(JSON.stringify({ role })).toString('base64url')
  return `header.${payload}.signature`
}

type RuntimeConfigStub = Record<string, unknown>

function baseConfig(overrides: RuntimeConfigStub = {}): RuntimeConfigStub {
  return {
    sessionSecret: 's'.repeat(32),
    authProvider: 'supabase',
    databaseProvider: 'supabase',
    postgres: { url: '' },
    authJwtSecret: '',
    supabase: {
      url: 'https://project.supabase.co',
      serviceRoleKey: jwtWithRole('service_role'),
      anonKey: jwtWithRole('anon'),
    },
    github: { appId: '', clientId: '', clientSecret: '', privateKey: '', webhookSecret: '' },
    anthropic: { apiKey: 'anthropic-key' },
    cdn: { r2AccountId: '', r2AccessKeyId: '', r2SecretAccessKey: '', r2Bucket: '' },
    resend: { apiKey: '' },
    oauth: {},
    ...overrides,
  }
}

async function loadPlugin(config: RuntimeConfigStub) {
  vi.stubGlobal('defineNitroPlugin', (fn: () => void) => fn)
  vi.stubGlobal('useRuntimeConfig', () => config)
  const mod = await import('../../server/plugins/00.validate-config')
  return mod.default as unknown as () => void
}

function runAndCapture(plugin: () => void): Error | null {
  try {
    plugin()
    return null
  }
  catch (error) {
    return error as Error
  }
}

describe('00.validate-config boot validation', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('accepts the default supabase+supabase pair with complete env', async () => {
    const plugin = await loadPlugin(baseConfig())

    expect(() => plugin()).not.toThrow()
  })

  it('treats unset selectors as the supabase pair', async () => {
    const plugin = await loadPlugin(baseConfig({ authProvider: '', databaseProvider: '' }))

    expect(() => plugin()).not.toThrow()
  })

  it('requires the Supabase env while the supabase database provider is selected', async () => {
    const plugin = await loadPlugin(baseConfig({
      supabase: { url: '', serviceRoleKey: '', anonKey: '' },
    }))

    const error = runAndCapture(plugin)
    expect(error?.message).toMatch(/NUXT_SUPABASE_URL is required/)
    expect(error?.message).toMatch(/NUXT_SUPABASE_SERVICE_ROLE_KEY is required/)
    expect(error?.message).toMatch(/NUXT_SUPABASE_ANON_KEY is required/)
  })

  it('rejects a service-role key that carries the wrong claim', async () => {
    const plugin = await loadPlugin(baseConfig({
      supabase: {
        url: 'https://project.supabase.co',
        serviceRoleKey: jwtWithRole('anon'),
        anonKey: 'plain-anon-key',
      },
    }))

    expect(runAndCapture(plugin)?.message).toMatch(/has role "anon" — expected "service_role"/)
  })

  it('rejects unknown provider selections', async () => {
    const plugin = await loadPlugin(baseConfig({ authProvider: 'auth0', databaseProvider: 'mysql' }))

    const error = runAndCapture(plugin)
    expect(error?.message).toMatch(/NUXT_AUTH_PROVIDER "auth0" is unknown/)
    expect(error?.message).toMatch(/NUXT_DATABASE_PROVIDER "mysql" is unknown/)
  })

  it('rejects the managed auth provider combined with the supabase database', async () => {
    const plugin = await loadPlugin(baseConfig({ authProvider: 'managed' }))

    expect(runAndCapture(plugin)?.message).toMatch(/cannot be combined/)
  })

  it('rejects supabase auth combined with the postgres database', async () => {
    const plugin = await loadPlugin(baseConfig({
      databaseProvider: 'postgres',
      postgres: { url: 'postgres://user:pw@host:5432/db' },
    }))

    expect(runAndCapture(plugin)?.message).toMatch(/cannot be combined/)
  })

  it('accepts a fully-configured managed+postgres pair without demanding Supabase env', async () => {
    const plugin = await loadPlugin(baseConfig({
      authProvider: 'managed',
      databaseProvider: 'postgres',
      postgres: { url: 'postgres://user:pw@host:5432/db' },
      authJwtSecret: 'j'.repeat(32),
      resend: { apiKey: 're_key' },
      oauth: { github: { clientId: 'Ov23liXXXX', clientSecret: 'oauth-secret' } },
      // Supabase env is intentionally absent — it must NOT be demanded here.
      supabase: { url: '', serviceRoleKey: '', anonKey: '' },
    }))

    expect(() => plugin()).not.toThrow()
  })

  it('requires the GitHub login OAuth app for managed auth', async () => {
    const plugin = await loadPlugin(baseConfig({
      authProvider: 'managed',
      databaseProvider: 'postgres',
      postgres: { url: 'postgres://user:pw@host:5432/db' },
      authJwtSecret: 'j'.repeat(32),
      resend: { apiKey: 're_key' },
      supabase: { url: '', serviceRoleKey: '', anonKey: '' },
    }))

    expect(runAndCapture(plugin)?.message).toMatch(/NUXT_OAUTH_GITHUB_CLIENT_ID/)
  })

  it('requires NUXT_POSTGRES_URL for the postgres database provider', async () => {
    const plugin = await loadPlugin(baseConfig({
      authProvider: 'managed',
      databaseProvider: 'postgres',
      authJwtSecret: 'j'.repeat(32),
      resend: { apiKey: 're_key' },
    }))

    expect(runAndCapture(plugin)?.message).toMatch(/NUXT_POSTGRES_URL is required/)
  })

  it('requires a long JWT secret and a Resend key for managed auth', async () => {
    const plugin = await loadPlugin(baseConfig({
      authProvider: 'managed',
      databaseProvider: 'postgres',
      postgres: { url: 'postgres://user:pw@host:5432/db' },
      authJwtSecret: 'too-short',
    }))

    const error = runAndCapture(plugin)
    expect(error?.message).toMatch(/NUXT_AUTH_JWT_SECRET must be at least 32 characters/)
    expect(error?.message).toMatch(/NUXT_RESEND_API_KEY is required/)
  })

  it('keeps the GitHub App completeness checks', async () => {
    const plugin = await loadPlugin(baseConfig({
      github: { appId: '123', clientId: '', clientSecret: '', privateKey: '', webhookSecret: '' },
    }))

    const error = runAndCapture(plugin)
    expect(error?.message).toMatch(/NUXT_GITHUB_CLIENT_ID is required/)
    expect(error?.message).toMatch(/NUXT_GITHUB_PRIVATE_KEY is required/)
  })

  it('warns (not errors) when the nuxt-auth-utils session password is missing', async () => {
    const warnSpy = vi.spyOn(console, 'warn')
    const plugin = await loadPlugin(baseConfig())

    expect(runAndCapture(plugin)).toBeNull()
    const warned = warnSpy.mock.calls.some(call => String(call[0]).includes('NUXT_SESSION_PASSWORD'))
    expect(warned).toBe(true)
  })

  it('stays quiet about the module session when its password is configured', async () => {
    const warnSpy = vi.spyOn(console, 'warn')
    const plugin = await loadPlugin(baseConfig({
      session: { password: 'p'.repeat(32) },
    }))

    expect(runAndCapture(plugin)).toBeNull()
    const warned = warnSpy.mock.calls.some(call => String(call[0]).includes('NUXT_SESSION_PASSWORD'))
    expect(warned).toBe(false)
  })
})

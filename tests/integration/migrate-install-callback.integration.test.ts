import { beforeEach, describe, expect, it, vi } from 'vitest'
import { withTestServer } from '../helpers/http'
import { signMigrateInstallState } from '../../server/utils/migrate-install-state'

const stateKey = 'k'.repeat(40)
const key = new TextEncoder().encode(stateKey)

const mocks = vi.hoisted(() => ({
  db: {
    getWorkspaceForUser: vi.fn(),
    getWorkspaceById: vi.fn(),
    getMigrateGrantForUser: vi.fn(),
    claimMigrateS2sJti: vi.fn(),
    findWorkspaceByGithubInstallation: vi.fn(),
    updateWorkspaceGithubInstallation: vi.fn(),
    upsertOAuthProviderToken: vi.fn(),
    getOAuthProviderToken: vi.fn(),
  },
  auth: { getUserById: vi.fn(), refreshProviderToken: vi.fn() },
  gitAppService: { verifyUserHasAccessToInstallation: vi.fn() },
  completeOAuthSignIn: vi.fn(),
  exchange: vi.fn(),
}))

vi.mock('../../server/utils/providers', () => ({
  useDatabaseProvider: vi.fn(() => mocks.db),
  useAuthProvider: vi.fn(() => mocks.auth),
  useGitAppService: vi.fn(() => mocks.gitAppService),
}))
vi.mock('../../server/providers/managed-auth', () => ({ completeOAuthSignIn: mocks.completeOAuthSignIn }))
vi.mock('../../server/utils/github-user-code', () => ({ exchangeGitHubInstallCode: mocks.exchange }))

const grantRow = { id: 'grant-1', order_id: 'ord_123', user_id: 'user-1', workspace_id: 'ws-1', bound_at: 'x', redeemed_at: 'y' }
const installer = { id: '4242', login: 'octocat', tokens: { accessToken: 'ghu_1', refreshToken: 'ghr_1', expiresAt: 1, refreshTokenExpiresAt: 2 } }

async function setupHandler() {
  return (await import('../../server/api/github/setup.get')).default
}

describe('GitHub setup callback: Migrate install state', () => {
  const setServerSession = vi.fn()
  const requireAuth = vi.fn()
  let config: Record<string, unknown>

  const stateToken = async (over: Partial<{ grantId: string, workspaceId: string, userId: string }> = {}) =>
    (await signMigrateInstallState({ grantId: 'grant-1', workspaceId: 'ws-1', userId: 'user-1', ...over }, key)).token

  const get = async (query: string) => {
    let response!: Response
    await withTestServer({ routes: [{ path: '/api/github/setup', handler: await setupHandler() }] }, async ({ request }) => {
      response = await request(`/api/github/setup?${query}`, { redirect: 'manual' })
    })
    return response
  }

  beforeEach(() => {
    config = { sessionSecret: 'test-session-secret-32-characters-min', authProvider: 'managed', migrate: { installStateKey: stateKey }, public: { siteUrl: 'http://localhost:3000' } }
    for (const fn of [...Object.values(mocks.db), ...Object.values(mocks.auth), ...Object.values(mocks.gitAppService), mocks.completeOAuthSignIn, mocks.exchange, setServerSession, requireAuth]) fn.mockReset()
    mocks.db.getMigrateGrantForUser.mockResolvedValue(grantRow)
    mocks.db.getWorkspaceById.mockResolvedValue({ id: 'ws-1', slug: 'acme', github_installation_id: null })
    mocks.db.claimMigrateS2sJti.mockResolvedValue(true)
    mocks.db.findWorkspaceByGithubInstallation.mockResolvedValue(null)
    mocks.db.updateWorkspaceGithubInstallation.mockResolvedValue(undefined)
    mocks.db.upsertOAuthProviderToken.mockResolvedValue(undefined)
    mocks.exchange.mockResolvedValue(installer)
    mocks.gitAppService.verifyUserHasAccessToInstallation.mockResolvedValue(true)
    mocks.auth.getUserById.mockResolvedValue({ id: 'user-1', email: 'owner@example.com', avatarUrl: null, provider: 'github', providerAccountId: '4242' })
    mocks.completeOAuthSignIn.mockResolvedValue({
      user: { id: 'user-1' }, tokens: { accessToken: 'at', refreshToken: 'rt', expiresAt: 99 },
    })
    vi.stubGlobal('useRuntimeConfig', () => config)
    vi.stubGlobal('setServerSession', setServerSession)
    vi.stubGlobal('requireAuth', requireAuth)
    vi.stubGlobal('useDatabaseProvider', () => mocks.db)
    vi.stubGlobal('useAuthProvider', () => mocks.auth)
  })

  it('binds the installation to the grant\'s workspace, signs the owner in and opens the workspace', async () => {
    const response = await get(`installation_id=555&code=abc&setup_action=install&state=${await stateToken()}`)
    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toBe('/w/acme')
    expect(mocks.exchange).toHaveBeenCalledWith('abc')
    expect(mocks.gitAppService.verifyUserHasAccessToInstallation).toHaveBeenCalledWith('ghu_1', 555)
    expect(mocks.db.updateWorkspaceGithubInstallation).toHaveBeenCalledWith('ws-1', 555)
    expect(mocks.db.upsertOAuthProviderToken).toHaveBeenCalledWith({ userId: 'user-1', provider: 'github', ...installer.tokens })
    expect(setServerSession).toHaveBeenCalledWith(expect.anything(), { userId: 'user-1', accessToken: 'at', refreshToken: 'rt', expiresAt: 99 })
    expect(requireAuth).not.toHaveBeenCalled()
  })

  it('takes the state\'s id once: a replayed callback binds nothing', async () => {
    mocks.db.claimMigrateS2sJti.mockResolvedValue(false)
    const response = await get(`installation_id=555&code=abc&state=${await stateToken()}`)
    expect(response.status).toBe(409)
    expect(mocks.exchange).not.toHaveBeenCalled()
    expect(mocks.db.updateWorkspaceGithubInstallation).not.toHaveBeenCalled()
    expect(mocks.db.claimMigrateS2sJti).toHaveBeenCalledWith(expect.any(String), 'install-state', expect.any(Date))
  })

  it('binds but does not sign in when someone else installed (an org admin): the payer is sent to sign in', async () => {
    mocks.exchange.mockResolvedValue({ ...installer, id: '9999' })
    const response = await get(`installation_id=555&code=abc&state=${await stateToken()}`)
    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toBe(`/auth/login?redirect=${encodeURIComponent('/migrate/claim?grant=grant-1')}`)
    expect(mocks.db.updateWorkspaceGithubInstallation).toHaveBeenCalledWith('ws-1', 555)
    expect(mocks.completeOAuthSignIn).not.toHaveBeenCalled()
    expect(setServerSession).not.toHaveBeenCalled()
    expect(mocks.db.upsertOAuthProviderToken).not.toHaveBeenCalled()
  })

  it('does not sign in a grant owner who did not sign in with GitHub', async () => {
    mocks.auth.getUserById.mockResolvedValue({ id: 'user-1', email: 'owner@example.com', avatarUrl: null, provider: 'google', providerAccountId: '4242' })
    const response = await get(`installation_id=555&code=abc&state=${await stateToken()}`)
    expect(response.headers.get('location')).toContain('/auth/login')
    expect(setServerSession).not.toHaveBeenCalled()
  })

  it('binds nothing without the installer\'s authorization code', async () => {
    const response = await get(`installation_id=555&state=${await stateToken()}`)
    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toContain('/auth/login')
    expect(mocks.db.updateWorkspaceGithubInstallation).not.toHaveBeenCalled()
    expect(mocks.db.claimMigrateS2sJti).not.toHaveBeenCalled()
  })

  const failedTo = `/auth/login?redirect=${encodeURIComponent('/migrate/claim?grant=grant-1&install=failed')}`

  it('binds nothing when GitHub rejects the code or the installer cannot reach the installation, and lands the customer on the claim screen', async () => {
    mocks.exchange.mockResolvedValueOnce(null)
    const rejected = await get(`installation_id=555&code=bad&state=${await stateToken()}`)
    expect([rejected.status, rejected.headers.get('location')]).toEqual([302, failedTo])

    mocks.gitAppService.verifyUserHasAccessToInstallation.mockResolvedValue(false)
    const denied = await get(`installation_id=555&code=abc&state=${await stateToken()}`)
    expect([denied.status, denied.headers.get('location')]).toEqual([302, failedTo])
    expect(mocks.db.updateWorkspaceGithubInstallation).not.toHaveBeenCalled()
    expect(setServerSession).not.toHaveBeenCalled()
  })

  it('refuses an installation another workspace already holds', async () => {
    mocks.db.findWorkspaceByGithubInstallation.mockResolvedValue({ id: 'ws-other' })
    const response = await get(`installation_id=555&code=abc&state=${await stateToken()}`)
    expect([response.status, response.headers.get('location')]).toEqual([302, failedTo])
    expect(mocks.db.findWorkspaceByGithubInstallation).toHaveBeenCalledWith(555, 'ws-1')
    expect(mocks.db.updateWorkspaceGithubInstallation).not.toHaveBeenCalled()
    expect(setServerSession).not.toHaveBeenCalled()
  })

  it('never swaps an installation the workspace already holds for a different one', async () => {
    mocks.db.getWorkspaceById.mockResolvedValue({ id: 'ws-1', slug: 'acme', github_installation_id: 111 })
    const response = await get(`installation_id=555&code=abc&state=${await stateToken()}`)
    expect([response.status, response.headers.get('location')]).toEqual([302, failedTo])
    expect(mocks.db.updateWorkspaceGithubInstallation).not.toHaveBeenCalled()
    expect(mocks.db.findWorkspaceByGithubInstallation).not.toHaveBeenCalled()
    expect(mocks.exchange).not.toHaveBeenCalled()
    expect(setServerSession).not.toHaveBeenCalled()
  })

  it('rewrites nothing when the workspace already holds this installation, and still signs the owner in', async () => {
    mocks.db.getWorkspaceById.mockResolvedValue({ id: 'ws-1', slug: 'acme', github_installation_id: 555 })
    const response = await get(`installation_id=555&code=abc&state=${await stateToken()}`)
    expect(response.headers.get('location')).toBe('/w/acme')
    expect(mocks.db.updateWorkspaceGithubInstallation).not.toHaveBeenCalled()
  })

  it('refuses a bad, foreign, unconfigured or mismatched state before any lookup of the installer', async () => {
    expect((await get('installation_id=555&code=abc&state=a.b.c')).status).toBe(400)
    expect((await get(`installation_id=abc&code=abc&state=${await stateToken()}`)).status).toBe(400)

    // The state names a workspace that is not the grant's.
    expect((await get(`installation_id=555&code=abc&state=${await stateToken({ workspaceId: 'ws-2' })}`)).status).toBe(400)
    // The grant is not redeemed.
    mocks.db.getMigrateGrantForUser.mockResolvedValue({ ...grantRow, redeemed_at: null })
    expect((await get(`installation_id=555&code=abc&state=${await stateToken()}`)).status).toBe(400)
    // Install links are off here.
    config.migrate = { installStateKey: '' }
    expect((await get(`installation_id=555&code=abc&state=${await stateToken()}`)).status).toBe(400)

    expect(mocks.exchange).not.toHaveBeenCalled()
    expect(mocks.db.updateWorkspaceGithubInstallation).not.toHaveBeenCalled()
  })

  it('leaves the in-app install (a workspace id as state) on its session-protected path', async () => {
    requireAuth.mockReturnValue({ user: { id: 'user-1' }, accessToken: 'token-1' })
    mocks.db.getWorkspaceForUser.mockResolvedValue({ id: 'workspace-primary', slug: 'studio-team' })
    mocks.db.getOAuthProviderToken.mockResolvedValue(null)
    const response = await get('installation_id=123&state=workspace-primary')
    expect(response.headers.get('location')).toBe('/w/studio-team')
    expect(requireAuth).toHaveBeenCalled()
    expect(mocks.db.getWorkspaceForUser).toHaveBeenCalledWith('token-1', 'user-1', 'workspace-primary', ['owner', 'admin'])
    expect(mocks.exchange).not.toHaveBeenCalled()
    expect(mocks.db.claimMigrateS2sJti).not.toHaveBeenCalled()
  })
})

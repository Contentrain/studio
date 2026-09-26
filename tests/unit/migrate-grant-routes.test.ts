import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

function createErrorLike(input: { statusCode: number, message: string }) {
  return Object.assign(new Error(input.message), input)
}

const verifyMigrateClaim = vi.fn()
vi.mock('../../server/utils/migrate-claim', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../server/utils/migrate-claim')>()
  return { ...actual, verifyMigrateClaim: (...args: unknown[]) => verifyMigrateClaim(...args) }
})
const planSource = { value: 'subscription' }
vi.mock('../../server/utils/deployment', () => ({ resolveDeployment: () => ({ planSource: planSource.value }) }))

const grantRow = {
  id: 'grant-1',
  order_id: 'ord_123',
  user_id: 'user-1',
  plan: 'pro',
  trial_days: 60,
  repo_owner: 'acme',
  repo_name: 'blog',
  email: 'owner@example.com',
  workspace_id: null,
  bound_at: null,
  redeemed_at: null,
}

const verified = {
  claim: { v: 1, order_id: 'ord_123', email: 'owner@example.com', plan: 'pro', trial_days: 60, repo: { provider: 'github', owner: 'acme', name: 'blog' }, origin: 'https://old-blog.example' },
  jti: 'jti-1',
  subject: 'migrate-user-1',
}

describe('Migrate grant routes', () => {
  let db: Record<string, ReturnType<typeof vi.fn>>
  let createCheckoutSession: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.resetModules()
    planSource.value = 'subscription'
    verifyMigrateClaim.mockReset().mockResolvedValue(verified)
    createCheckoutSession = vi.fn().mockResolvedValue({ url: 'https://checkout.polar.sh/c/test', sessionId: 'cs_1' })
    db = {
      claimMigrateGrant: vi.fn().mockResolvedValue({ grant: grantRow, created: true }),
      getMigrateGrantForUser: vi.fn().mockResolvedValue(grantRow),
      bindMigrateGrantWorkspace: vi.fn().mockResolvedValue({ ...grantRow, workspace_id: 'ws-1', bound_at: '2026-09-23T12:00:00Z' }),
      getWorkspaceForUser: vi.fn().mockResolvedValue({ id: 'ws-1', slug: 'acme', name: 'Acme', trial_consumed_at: '2026-01-01T00:00:00Z' }),
      getActivePaymentAccount: vi.fn().mockResolvedValue(null),
      listWorkspaceProjects: vi.fn().mockResolvedValue([]),
    }
    vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
    vi.stubGlobal('createError', createErrorLike)
    vi.stubGlobal('errorMessage', vi.fn((key: string) => key))
    vi.stubGlobal('requireAuth', vi.fn().mockReturnValue({ user: { id: 'user-1', email: 'owner@example.com' }, accessToken: 'token-1' }))
    vi.stubGlobal('readBody', vi.fn().mockResolvedValue({ token: 'signed.claim.token', workspaceId: 'ws-1' }))
    vi.stubGlobal('getRouterParam', vi.fn().mockReturnValue('grant-1'))
    vi.stubGlobal('useRuntimeConfig', vi.fn().mockReturnValue({
      migrate: { claimPublicKey: '-----BEGIN PUBLIC KEY-----\\nMCow\\n-----END PUBLIC KEY-----' },
      public: { siteUrl: 'https://studio.example.com' },
    }))
    vi.stubGlobal('useDatabaseProvider', vi.fn(() => db))
    vi.stubGlobal('checkRateLimit', vi.fn().mockReturnValue({ allowed: true, remaining: 1, retryAfterMs: 0 }))
    vi.stubGlobal('usePaymentProvider', vi.fn().mockReturnValue({ createCheckoutSession }))
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  const claimRoute = async () => (await import('../../server/api/migrate/claim.post')).default
  const checkoutRoute = async () => (await import('../../server/api/migrate/grants/[grantId]/checkout.post')).default
  const grantRoute = async () => (await import('../../server/api/migrate/grants/[grantId]/index.get')).default

  describe('POST /api/migrate/claim', () => {
    it('records the grant on the signed-in account and returns what it includes', async () => {
      const result = await (await claimRoute())({} as never)

      expect(verifyMigrateClaim).toHaveBeenCalledWith('signed.claim.token', '-----BEGIN PUBLIC KEY-----\nMCow\n-----END PUBLIC KEY-----')
      expect(db.claimMigrateGrant).toHaveBeenCalledWith(expect.objectContaining({
        orderId: 'ord_123',
        claimJti: 'jti-1',
        userId: 'user-1',
        plan: 'pro',
        trialDays: 60,
        repoOwner: 'acme',
        repoName: 'blog',
        // The signed site: media import fetches old-site files from here only.
        origin: 'https://old-blog.example',
      }))
      expect(result).toMatchObject({ grant: { id: 'grant-1', plan: 'pro', trialDays: 60, state: 'claimed', repo: { owner: 'acme', name: 'blog' } } })
    })

    it('refuses an order another account already claimed', async () => {
      db.claimMigrateGrant!.mockResolvedValue({ grant: { ...grantRow, user_id: 'user-2' }, created: false })
      await expect((await claimRoute())({} as never)).rejects.toMatchObject({ statusCode: 409, message: 'migrate.claim_taken' })
    })

    it('tells an expired link apart from a bad one', async () => {
      const { MigrateClaimError } = await import('../../server/utils/migrate-claim')
      verifyMigrateClaim.mockRejectedValueOnce(new MigrateClaimError('expired', 'x'))
      await expect((await claimRoute())({} as never)).rejects.toMatchObject({ statusCode: 410 })
      verifyMigrateClaim.mockRejectedValueOnce(new MigrateClaimError('invalid', 'x'))
      await expect((await claimRoute())({} as never)).rejects.toMatchObject({ statusCode: 400 })
      expect(db.claimMigrateGrant).not.toHaveBeenCalled()
    })

    it('is off without Migrate\'s key, and on deployments that do not sell subscriptions', async () => {
      vi.stubGlobal('useRuntimeConfig', vi.fn().mockReturnValue({ migrate: { claimPublicKey: '' }, public: {} }))
      await expect((await claimRoute())({} as never)).rejects.toMatchObject({ statusCode: 404 })

      vi.stubGlobal('useRuntimeConfig', vi.fn().mockReturnValue({ migrate: { claimPublicKey: 'pem' }, public: {} }))
      planSource.value = 'operator'
      await expect((await claimRoute())({} as never)).rejects.toMatchObject({ statusCode: 404 })
      expect(verifyMigrateClaim).not.toHaveBeenCalled()
    })
  })

  describe('the way to the delivered site', () => {
    const bound = { ...grantRow, workspace_id: 'ws-1', bound_at: '2026-09-23T12:00:00Z', redeemed_at: '2026-09-23T12:05:00Z' }

    it('none before the grant is tied to a workspace', async () => {
      expect(await (await claimRoute())({} as never)).toMatchObject({ destination: null })
      expect(db.listWorkspaceProjects).not.toHaveBeenCalled()
    })

    it('the project connected to the grant\'s repo in its workspace (repo names compared without case)', async () => {
      db.claimMigrateGrant!.mockResolvedValue({ grant: bound, created: false })
      db.getMigrateGrantForUser!.mockResolvedValue(bound)
      db.listWorkspaceProjects!.mockResolvedValue([
        { id: 'p-other', repo_full_name: 'acme/docs' },
        { id: 'p-1', repo_full_name: 'Acme/Blog' },
      ])
      expect(await (await claimRoute())({} as never)).toMatchObject({ grant: { state: 'redeemed' }, destination: { workspaceSlug: 'acme', projectId: 'p-1' } })
      expect(await (await grantRoute())({} as never)).toMatchObject({ destination: { workspaceSlug: 'acme', projectId: 'p-1' } })
      expect(db.getWorkspaceForUser).toHaveBeenCalledWith('token-1', 'user-1', 'ws-1', ['owner', 'admin'], 'id, slug')
    })

    it('the workspace alone until the repo is connected there; nothing once the caller no longer administers it', async () => {
      db.getMigrateGrantForUser!.mockResolvedValue(bound)
      db.listWorkspaceProjects!.mockResolvedValue([{ id: 'p-other', repo_full_name: 'acme/docs' }])
      expect(await (await grantRoute())({} as never)).toMatchObject({ destination: { workspaceSlug: 'acme', projectId: null } })
      db.getWorkspaceForUser!.mockResolvedValue(null)
      expect(await (await grantRoute())({} as never)).toMatchObject({ destination: null })
    })
  })

  describe('POST /api/migrate/grants/:grantId/checkout', () => {
    it('opens the grant\'s plan at its regular price with the grant\'s trial, even after an earlier trial', async () => {
      const result = await (await checkoutRoute())({} as never)

      expect(db.bindMigrateGrantWorkspace).toHaveBeenCalledWith('grant-1', 'ws-1')
      expect(createCheckoutSession).toHaveBeenCalledWith(expect.objectContaining({
        workspaceId: 'ws-1',
        plan: 'pro',
        withTrial: true,
        trialDays: 60,
        metadata: { migrate_grant_id: 'grant-1' },
        successUrl: 'https://studio.example.com/w/acme?billing=success',
      }))
      expect(result).toEqual({ url: 'https://checkout.polar.sh/c/test' })
    })

    it('opens no checkout once the grant has been used', async () => {
      db.getMigrateGrantForUser!.mockResolvedValue({ ...grantRow, workspace_id: 'ws-1', bound_at: '2026-09-23T12:00:00Z', redeemed_at: '2026-09-23T12:05:00Z' })
      await expect((await checkoutRoute())({} as never)).rejects.toMatchObject({ statusCode: 409, message: 'migrate.grant_used' })
      expect(createCheckoutSession).not.toHaveBeenCalled()
    })

    it('keeps a grant on the workspace it was first opened for', async () => {
      db.getMigrateGrantForUser!.mockResolvedValue({ ...grantRow, workspace_id: 'ws-other', bound_at: '2026-09-23T12:00:00Z' })
      await expect((await checkoutRoute())({} as never)).rejects.toMatchObject({ statusCode: 409, message: 'migrate.grant_bound_elsewhere' })

      // Lost the race to another tab binding it elsewhere.
      db.getMigrateGrantForUser!.mockResolvedValue(grantRow)
      db.bindMigrateGrantWorkspace!.mockResolvedValue(null)
      await expect((await checkoutRoute())({} as never)).rejects.toMatchObject({ statusCode: 409, message: 'migrate.grant_bound_elsewhere' })
      expect(createCheckoutSession).not.toHaveBeenCalled()
    })

    it('needs owner or admin on the workspace, and a grant the caller owns', async () => {
      db.getWorkspaceForUser!.mockResolvedValue(null)
      await expect((await checkoutRoute())({} as never)).rejects.toMatchObject({ statusCode: 403 })

      db.getMigrateGrantForUser!.mockResolvedValue(null)
      await expect((await checkoutRoute())({} as never)).rejects.toMatchObject({ statusCode: 404 })
      expect(db.bindMigrateGrantWorkspace).not.toHaveBeenCalled()
    })

    it('does not start a second subscription on a subscribed workspace, nor tie the grant to it', async () => {
      db.getActivePaymentAccount!.mockResolvedValue({ subscription_id: 'sub_1', subscription_status: 'active' })
      await expect((await checkoutRoute())({} as never)).rejects.toMatchObject({ statusCode: 409, message: 'billing.subscription_exists' })
      expect(db.bindMigrateGrantWorkspace).not.toHaveBeenCalled()
      expect(createCheckoutSession).not.toHaveBeenCalled()
    })
  })
})

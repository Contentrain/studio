import { exportSPKI, generateKeyPair, SignJWT } from 'jose'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

function createErrorLike(input: { statusCode: number, message: string }) {
  return Object.assign(new Error(input.message), input)
}

const resolveMigrateAccountState = vi.fn()
const coveringWorkspace = vi.fn()
vi.mock('../../server/utils/migrate-account-state', () => ({
  resolveMigrateAccountState: (...args: unknown[]) => resolveMigrateAccountState(...args),
  coveringWorkspace: (...args: unknown[]) => coveringWorkspace(...args),
}))
const planSource = { value: 'subscription' }
vi.mock('../../server/utils/deployment', () => ({ resolveDeployment: () => ({ planSource: planSource.value }) }))

const NOW = new Date('2026-10-10T12:00:00Z')
const nowSec = Math.floor(NOW.getTime() / 1000)

const claim = (overrides: Record<string, unknown> = {}) => ({
  iss: 'contentrain-migrate',
  aud: 'contentrain-studio',
  v: 2,
  jti: 'jti-1',
  iat: nowSec,
  exp: nowSec + 300,
  sub: 'ten_1',
  order_id: 'ord_1',
  email: 'owner@example.com',
  plan: 'pro',
  plan_evidence: [],
  github_user_id: '4242',
  email_verified: true,
  return_url: 'https://migrate.contentrain.io/orders/ord_1?studio=done',
  billing: { migrate_fee_cents: 24900, quoted_total_cents: 64100, currency: 'usd' },
  origin: 'https://old-blog.example',
  ...overrides,
})

const user = { id: 'user-1', email: 'owner@example.com' }
const workspace = { id: 'ws-1', slug: 'owner-abc', name: 'Owner' }
const bundleRow = (overrides: Record<string, unknown> = {}) => ({
  id: 'grant-1', order_id: 'ord_1', user_id: 'user-1', kind: 'bundle', plan: 'pro',
  redeemed_at: null, bound_at: null, workspace_id: null,
  checkout_url: null, checkout_expires_at: null, amount_cents: null,
  ...overrides,
})

describe('provisionMigrateBundle', () => {
  let db: Record<string, ReturnType<typeof vi.fn>>
  let auth: { ensureUserForProviderAccount: ReturnType<typeof vi.fn> }
  let payment: { createBundleCheckout: ReturnType<typeof vi.fn> }

  beforeEach(() => {
    vi.resetModules()
    resolveMigrateAccountState.mockReset().mockResolvedValue({ state: 'none', plan: 'pro', year1_cents: 39200 })
    coveringWorkspace.mockReset().mockResolvedValue({ id: 'ws-paid', slug: 'agency' })
    db = {
      listOwnedWorkspacesAdmin: vi.fn().mockResolvedValue([{ id: 'ws-other', type: 'team' }, { id: 'ws-1', type: 'primary' }]),
      getWorkspaceById: vi.fn().mockResolvedValue(workspace),
      getActivePaymentAccount: vi.fn().mockResolvedValue(null),
      claimMigrateGrant: vi.fn().mockResolvedValue({ grant: bundleRow(), created: true }),
      bindMigrateGrantWorkspace: vi.fn().mockResolvedValue(bundleRow({ workspace_id: 'ws-1', bound_at: '2026-10-10T12:00:00Z' })),
      saveMigrateGrantCheckout: vi.fn().mockResolvedValue(undefined),
    }
    auth = { ensureUserForProviderAccount: vi.fn().mockResolvedValue(user) }
    payment = {
      createBundleCheckout: vi.fn().mockResolvedValue({
        url: 'https://sandbox.polar.sh/checkout/c_1',
        sessionId: 'co_1',
        expiresAt: '2026-10-10T13:00:00.000Z',
        targetProductId: 'prod_pro_y',
      }),
    }
    vi.stubGlobal('createError', createErrorLike)
    vi.stubGlobal('errorMessage', vi.fn((key: string) => key))
    vi.stubGlobal('useDatabaseProvider', () => db)
    vi.stubGlobal('useAuthProvider', () => auth)
    vi.stubGlobal('usePaymentProvider', () => payment)
    vi.stubGlobal('checkRateLimit', vi.fn().mockResolvedValue({ allowed: true }))
    vi.stubGlobal('useRuntimeConfig', () => ({
      public: { siteUrl: 'https://studio.example.com' },
      migrate: { origins: 'https://migrate.contentrain.io' },
    }))
  })

  const run = async (c = claim()) => (await import('../../server/utils/migrate-provision')).provisionMigrateBundle(c as never, NOW)
  const refused = async (c = claim()) => run(c).then(() => null, (err: { statusCode: number, message: string }) => ({ status: err.statusCode, key: err.message }))

  it('provisions an account with no plan: user, grant bound to its personal workspace, one checkout at the quoted total', async () => {
    const response = await run()

    expect(auth.ensureUserForProviderAccount).toHaveBeenCalledWith({ provider: 'github', accountId: '4242', email: 'owner@example.com' })
    expect(db.claimMigrateGrant).toHaveBeenCalledWith(expect.objectContaining({ orderId: 'ord_1', claimJti: 'jti-1', userId: 'user-1', plan: 'pro', kind: 'bundle', origin: 'https://old-blog.example' }))
    expect(db.claimMigrateGrant.mock.calls[0]![0]).not.toHaveProperty('trialDays')
    expect(db.bindMigrateGrantWorkspace).toHaveBeenCalledWith('grant-1', 'ws-1')
    expect(payment.createBundleCheckout).toHaveBeenCalledTimes(1)
    expect(payment.createBundleCheckout).toHaveBeenCalledWith({
      workspaceId: 'ws-1',
      plan: 'pro',
      customerEmail: 'owner@example.com',
      amountCents: 64100,
      successUrl: 'https://migrate.contentrain.io/orders/ord_1?studio=done',
      metadata: { order_id: 'ord_1', tenant_id: 'ten_1', migrate_grant_id: 'grant-1', migrate_bundle: 'true', studio_url: 'https://studio.example.com' },
    })
    expect(db.saveMigrateGrantCheckout).toHaveBeenCalledWith('grant-1', {
      checkoutId: 'co_1',
      checkoutUrl: 'https://sandbox.polar.sh/checkout/c_1',
      checkoutExpiresAt: '2026-10-10T13:00:00.000Z',
      amountCents: 64100,
      targetProductId: 'prod_pro_y',
    })
    expect(response).toEqual({
      grant_id: 'grant-1',
      state: 'bound',
      plan: 'pro',
      workspace_slug: 'owner-abc',
      checkout_url: 'https://sandbox.polar.sh/checkout/c_1',
      amount_cents: 64100,
      checkout_expires_at: Math.floor(new Date('2026-10-10T13:00:00Z').getTime() / 1000),
    })
  })

  it('refuses to answer a checkout for a grant that was paid in the same moment', async () => {
    db.bindMigrateGrantWorkspace.mockResolvedValue(bundleRow({ workspace_id: 'ws-1', redeemed_at: '2026-10-10T12:00:00Z' }))
    expect(await refused()).toEqual({ status: 409, key: 'migrate.grant_used' })
    expect(payment.createBundleCheckout).not.toHaveBeenCalled()
  })

  it('refuses a quote that is not what Studio computes now (Migrate fee + the Studio line)', async () => {
    expect(await refused(claim({ billing: { migrate_fee_cents: 24900, quoted_total_cents: 60000, currency: 'usd' } }))).toEqual({ status: 409, key: 'migrate.quote_changed' })
    resolveMigrateAccountState.mockResolvedValue({ state: 'none', plan: 'pro', year1_cents: 40000 })
    expect(await refused()).toEqual({ status: 409, key: 'migrate.quote_changed' })
    expect(payment.createBundleCheckout).not.toHaveBeenCalled()
    expect(auth.ensureUserForProviderAccount).not.toHaveBeenCalled()
  })

  it('refuses an account that needs an upgrade (too_small): never a checkout at the wrong amount', async () => {
    resolveMigrateAccountState.mockResolvedValue({ state: 'too_small', plan: 'pro', year1_cents: 0, current_plan: 'starter' })
    expect(await refused()).toEqual({ status: 409, key: 'migrate.bundle_state_unsupported' })
    expect(payment.createBundleCheckout).not.toHaveBeenCalled()
    expect(db.claimMigrateGrant).not.toHaveBeenCalled()
  })

  describe('an account whose running plan covers the order', () => {
    const covered = () => claim({ billing: { migrate_fee_cents: 24900, quoted_total_cents: 24900, currency: 'usd' } })
    beforeEach(() => {
      resolveMigrateAccountState.mockResolvedValue({ state: 'covers', plan: 'pro', year1_cents: 0, renewal_cents: 0, current_plan: 'pro' })
      db.bindMigrateGrantWorkspace.mockResolvedValue(bundleRow({ workspace_id: 'ws-paid', bound_at: '2026-10-10T12:00:00Z' }))
      db.markMigrateGrantRedeemed = vi.fn().mockResolvedValue(undefined)
    })

    it('ties the grant to the plan\'s workspace and answers redeemed: no checkout, no Polar call, Studio fee $0', async () => {
      expect(await run(covered())).toEqual({ grant_id: 'grant-1', state: 'redeemed', plan: 'pro', workspace_slug: 'agency' })
      expect(coveringWorkspace).toHaveBeenCalledWith('user-1', 'pro')
      expect(db.bindMigrateGrantWorkspace).toHaveBeenCalledWith('grant-1', 'ws-paid')
      expect(db.markMigrateGrantRedeemed).toHaveBeenCalledWith('grant-1', null)
      expect(payment.createBundleCheckout).not.toHaveBeenCalled()
      expect(db.saveMigrateGrantCheckout).not.toHaveBeenCalled()
      expect(db.getActivePaymentAccount).not.toHaveBeenCalled()
    })

    it('agrees only a quote equal to the Migrate fee (no Studio line)', async () => {
      expect(await refused(claim())).toEqual({ status: 409, key: 'migrate.quote_changed' })
      expect(db.claimMigrateGrant).not.toHaveBeenCalled()
    })

    it('is idempotent, and keeps the workspace the grant is already tied to', async () => {
      db.claimMigrateGrant.mockResolvedValue({ grant: bundleRow({ workspace_id: 'ws-1', redeemed_at: '2026-10-10T11:00:00Z' }), created: false })
      db.bindMigrateGrantWorkspace.mockResolvedValue(bundleRow({ workspace_id: 'ws-1', redeemed_at: '2026-10-10T11:00:00Z' }))
      expect(await run(covered())).toMatchObject({ state: 'redeemed', workspace_slug: 'owner-abc' })
      expect(db.bindMigrateGrantWorkspace).toHaveBeenCalledWith('grant-1', 'ws-1')
      expect(db.markMigrateGrantRedeemed).not.toHaveBeenCalled()
    })

    it('asks Migrate to re-quote when the plan stopped covering, and never reuses a grant opened with a checkout, a revoked or a foreign one', async () => {
      coveringWorkspace.mockResolvedValue(null)
      expect(await refused(covered())).toEqual({ status: 409, key: 'migrate.quote_changed' })
      coveringWorkspace.mockResolvedValue({ id: 'ws-paid', slug: 'agency' })
      db.claimMigrateGrant.mockResolvedValue({ grant: bundleRow({ checkout_url: 'https://sandbox.polar.sh/checkout/c_1' }), created: false })
      expect(await refused(covered())).toEqual({ status: 409, key: 'migrate.quote_changed' })
      db.claimMigrateGrant.mockResolvedValue({ grant: bundleRow({ revoked_at: '2026-10-10T11:00:00Z' }), created: false })
      expect(await refused(covered())).toEqual({ status: 409, key: 'migrate.grant_revoked' })
      db.claimMigrateGrant.mockResolvedValue({ grant: bundleRow({ user_id: 'user-2' }), created: false })
      expect(await refused(covered())).toEqual({ status: 409, key: 'migrate.claim_taken' })
      expect(db.markMigrateGrantRedeemed).not.toHaveBeenCalled()
      expect(payment.createBundleCheckout).not.toHaveBeenCalled()
    })
  })

  it('refuses a return address that is not on the Migrate allowlist, and an unverified email', async () => {
    for (const return_url of ['https://evil.example/orders/1', 'https://migrate.contentrain.io.evil.example/x']) {
      expect(await refused(claim({ return_url }))).toEqual({ status: 400, key: 'migrate.return_url_not_allowed' })
    }
    expect(await refused(claim({ email_verified: false }))).toEqual({ status: 400, key: 'migrate.email_unverified' })
    expect(auth.ensureUserForProviderAccount).not.toHaveBeenCalled()
  })

  it('refuses everything while no allowlist is configured', async () => {
    vi.stubGlobal('useRuntimeConfig', () => ({ public: { siteUrl: 'https://studio.example.com' }, migrate: { origins: '' } }))
    expect(await refused()).toEqual({ status: 400, key: 'migrate.return_url_not_allowed' })
  })

  it('refuses a workspace that already pays (a second subscription is never opened)', async () => {
    db.getActivePaymentAccount.mockResolvedValue({ subscription_id: 'sub_old', subscription_status: 'trialing' })
    expect(await refused()).toEqual({ status: 409, key: 'billing.subscription_exists' })
    expect(db.claimMigrateGrant).not.toHaveBeenCalled()
    db.getActivePaymentAccount.mockResolvedValue({ subscription_id: 'sub_old', subscription_status: 'canceled' })
    expect(await refused()).toBeNull()
  })

  it('a plan that is ending keeps its workspace: the bundle goes to another owned workspace without a subscription, never a second one on it', async () => {
    db.getActivePaymentAccount.mockImplementation(async (id: string) => (id === 'ws-1' ? { subscription_id: 'sub_ending', subscription_status: 'active', cancel_at_period_end: true } : null))
    db.getWorkspaceById.mockImplementation(async (id: string) => ({ id, slug: id, name: id }))
    expect(await refused()).toBeNull()
    expect(db.bindMigrateGrantWorkspace).toHaveBeenCalledWith(expect.anything(), 'ws-other')
  })

  it('refuses when every owned workspace already holds a subscription, ending ones included', async () => {
    db.getActivePaymentAccount.mockResolvedValue({ subscription_id: 'sub_ending', subscription_status: 'active', cancel_at_period_end: true })
    expect(await refused()).toEqual({ status: 409, key: 'billing.subscription_exists' })
    // The answer carries a stable code (the message is localised text) so Migrate can offer the way out.
    const error = await run(claim()).catch((e: { data?: unknown }) => e)
    expect((error as { data?: unknown }).data).toEqual({ code: 'subscription_exists', workspace_slug: 'owner-abc' })
    expect(db.claimMigrateGrant).not.toHaveBeenCalled()
  })

  it('refuses an email whose user has another GitHub account', async () => {
    // Loaded after the module reset, so it is the class the provision code sees.
    const { IdentityConflictError } = await import('../../server/providers/auth')
    auth.ensureUserForProviderAccount.mockRejectedValue(new IdentityConflictError())
    expect(await refused()).toEqual({ status: 409, key: 'migrate.identity_conflict' })
  })

  it('never reuses an order that belongs to another account, was a trial claim, or was paid', async () => {
    db.claimMigrateGrant.mockResolvedValue({ grant: bundleRow({ user_id: 'user-2' }), created: false })
    expect(await refused()).toEqual({ status: 409, key: 'migrate.claim_taken' })
    db.claimMigrateGrant.mockResolvedValue({ grant: bundleRow({ kind: 'trial' }), created: false })
    expect(await refused()).toEqual({ status: 409, key: 'migrate.claim_taken' })
    db.claimMigrateGrant.mockResolvedValue({ grant: bundleRow({ redeemed_at: '2026-10-09T00:00:00Z' }), created: false })
    expect(await refused()).toEqual({ status: 409, key: 'migrate.grant_used' })
    db.claimMigrateGrant.mockResolvedValue({ grant: bundleRow({ revoked_at: '2026-10-09T00:00:00Z', revoked_reason: 'refund_before_delivery' }), created: false })
    expect(await refused()).toEqual({ status: 409, key: 'migrate.grant_revoked' })
    db.claimMigrateGrant.mockResolvedValue({ grant: bundleRow(), created: false })
    db.bindMigrateGrantWorkspace.mockResolvedValue(null)
    expect(await refused()).toEqual({ status: 409, key: 'migrate.grant_bound_elsewhere' })
    expect(payment.createBundleCheckout).not.toHaveBeenCalled()
  })

  describe('a repeated provision for the same order', () => {
    const stored = (overrides: Record<string, unknown> = {}) => bundleRow({
      workspace_id: 'ws-1',
      checkout_url: 'https://sandbox.polar.sh/checkout/c_old',
      checkout_expires_at: '2026-10-10T13:00:00.000Z',
      amount_cents: 64100,
      ...overrides,
    })

    it('returns the checkout the grant already opened while it is payable and the amount is the same', async () => {
      db.claimMigrateGrant.mockResolvedValue({ grant: stored(), created: false })
      const response = await run()
      expect(response.checkout_url).toBe('https://sandbox.polar.sh/checkout/c_old')
      expect(payment.createBundleCheckout).not.toHaveBeenCalled()
      expect(db.saveMigrateGrantCheckout).not.toHaveBeenCalled()
    })

    it('opens a fresh one when the stored one is about to expire, expired, or for another amount', async () => {
      for (const overrides of [
        { checkout_expires_at: '2026-10-10T12:02:00.000Z' },
        { checkout_expires_at: '2026-10-10T11:00:00.000Z' },
        { amount_cents: 60000 },
      ]) {
        payment.createBundleCheckout.mockClear()
        db.claimMigrateGrant.mockResolvedValue({ grant: stored(overrides), created: false })
        expect((await run()).checkout_url).toBe('https://sandbox.polar.sh/checkout/c_1')
        expect(payment.createBundleCheckout).toHaveBeenCalledTimes(1)
      }
    })
  })

  it('turns a provider failure into a clean 502 and stores nothing', async () => {
    payment.createBundleCheckout.mockRejectedValue(new Error('polar down'))
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(await refused()).toEqual({ status: 502, key: 'billing.provider_unavailable' })
    expect(db.saveMigrateGrantCheckout).not.toHaveBeenCalled()
    errorLog.mockRestore()
  })

  it('answers 429 instead of opening a second checkout in the same moment', async () => {
    vi.stubGlobal('checkRateLimit', vi.fn().mockResolvedValue({ allowed: false }))
    expect(await refused()).toEqual({ status: 429, key: 'auth.rate_limited' })
    expect(payment.createBundleCheckout).not.toHaveBeenCalled()
  })

  it('never hands Migrate a checkout address that is not Polar\'s', async () => {
    payment.createBundleCheckout.mockResolvedValue({ url: 'https://evil.example/checkout/c_1', sessionId: 'co_1', expiresAt: '2026-10-10T13:00:00.000Z', targetProductId: 'prod_pro_y' })
    expect(await refused()).toEqual({ status: 502, key: 'billing.provider_unavailable' })
  })

  it('takes the personal workspace over the first one it finds', async () => {
    await run()
    expect(db.getWorkspaceById).toHaveBeenCalledWith('ws-1', 'id, slug, name')
  })
})

describe('POST /api/migrate/provision', () => {
  let publicPem: string
  let privateKey: CryptoKey
  let db: Record<string, ReturnType<typeof vi.fn>>
  const provisionMigrateBundle = vi.fn()

  beforeAll(async () => {
    const pair = await generateKeyPair('EdDSA', { extractable: true })
    privateKey = pair.privateKey
    publicPem = await exportSPKI(pair.publicKey)
  })

  const sign = (payload: Record<string, unknown> = {}) => {
    const iat = Math.floor(Date.now() / 1000)
    // `repo` is optional in claim v2 (@contentrain/types 1.44.0): the bundle opens before the delivery repo exists.
    return new SignJWT({ ...claim({ iat, exp: iat + 300 }), ...payload }).setProtectedHeader({ alg: 'EdDSA' }).sign(privateKey)
  }

  beforeEach(() => {
    vi.resetModules()
    provisionMigrateBundle.mockReset().mockResolvedValue({ grant_id: 'grant-1' })
    vi.doMock('../../server/utils/migrate-provision', () => ({ provisionMigrateBundle: (...args: unknown[]) => provisionMigrateBundle(...args) }))
    vi.doMock('../../server/utils/deployment', () => ({ resolveDeployment: () => ({ planSource: 'subscription' }) }))
    db = {
      claimMigrateS2sJti: vi.fn().mockResolvedValue(true),
      releaseMigrateS2sJti: vi.fn().mockResolvedValue(undefined),
    }
    vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
    vi.stubGlobal('createError', createErrorLike)
    vi.stubGlobal('errorMessage', vi.fn((key: string) => key))
    vi.stubGlobal('useDatabaseProvider', () => db)
    vi.stubGlobal('useRuntimeConfig', () => ({ migrate: { claimPublicKey: publicPem } }))
  })

  const call = async (token: unknown) => {
    vi.stubGlobal('readBody', vi.fn().mockResolvedValue({ token }))
    const handler = (await import('../../server/api/migrate/provision.post')).default as unknown as (event: unknown) => Promise<unknown>
    return handler({}).then(value => ({ value }), (err: { statusCode: number, message: string }) => ({ status: err.statusCode, key: err.message }))
  }

  it('verifies the signed claim v2, takes its jti for the provision purpose, and provisions', async () => {
    const result = await call(await sign())
    expect(result).toEqual({ value: { grant_id: 'grant-1' } })
    expect(db.claimMigrateS2sJti).toHaveBeenCalledWith('jti-1', 'provision', expect.any(Date))
    expect(provisionMigrateBundle).toHaveBeenCalledWith(expect.objectContaining({ v: 2, order_id: 'ord_1', github_user_id: '4242' }))
  })

  it('accepts a claim with no repo and one that names it', async () => {
    expect(await call(await sign())).toEqual({ value: { grant_id: 'grant-1' } })
    expect(provisionMigrateBundle.mock.calls[0]![0]).not.toHaveProperty('repo')
    await call(await sign({ jti: 'jti-2', repo: { provider: 'github', owner: 'acme', name: 'blog' } }))
    expect(provisionMigrateBundle.mock.calls[1]![0]).toHaveProperty('repo')
  })

  it('is off without Migrate\'s key', async () => {
    vi.stubGlobal('useRuntimeConfig', () => ({ migrate: { claimPublicKey: '' } }))
    expect(await call(await sign())).toEqual({ status: 404, key: 'migrate.unavailable' })
  })

  it('refuses a missing token, a bad signature, a v1 claim and a replay', async () => {
    expect(await call(undefined)).toEqual({ status: 400, key: 'migrate.s2s_invalid' })
    expect(await call('not.a.jws')).toEqual({ status: 400, key: 'migrate.s2s_invalid' })
    expect(await call(await sign({ v: 1 }))).toEqual({ status: 400, key: 'migrate.s2s_invalid' })
    db.claimMigrateS2sJti.mockResolvedValue(false)
    expect(await call(await sign())).toEqual({ status: 409, key: 'migrate.s2s_replayed' })
    expect(provisionMigrateBundle).not.toHaveBeenCalled()
  })

  it('gives the jti back only when Studio itself failed, not when it refused', async () => {
    provisionMigrateBundle.mockRejectedValue(Object.assign(new Error('x'), { statusCode: 409 }))
    await call(await sign())
    expect(db.releaseMigrateS2sJti).not.toHaveBeenCalled()

    provisionMigrateBundle.mockRejectedValue(Object.assign(new Error('x'), { statusCode: 502 }))
    await call(await sign())
    expect(db.releaseMigrateS2sJti).toHaveBeenCalledWith('jti-1')

    db.releaseMigrateS2sJti.mockClear()
    provisionMigrateBundle.mockRejectedValue(new Error('boom'))
    await call(await sign())
    expect(db.releaseMigrateS2sJti).toHaveBeenCalledWith('jti-1')
  })
})

import { exportSPKI, generateKeyPair, SignJWT } from 'jose'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { validateMigrateAccountStateRequest, validateMigrateAccountStateResponse } from '@contentrain/types'
import { MigrateS2sError, verifyMigrateS2sRequest } from '../../server/utils/migrate-s2s'
import { PLAN_PRICING } from '../../shared/utils/license'
import { STUDIO_YEARLY_LIST_CENTS, bundleUpgradeCents, bundleYear1Cents, monthlyListCents, planCovers, yearlySaving } from '../../shared/utils/migrate-bundle'

function createErrorLike(input: { statusCode: number, message: string }) {
  return Object.assign(new Error(input.message), input)
}

let privateKey: CryptoKey
let publicPem: string
let otherPrivate: CryptoKey

beforeAll(async () => {
  const pair = await generateKeyPair('EdDSA', { extractable: true })
  privateKey = pair.privateKey
  publicPem = await exportSPKI(pair.publicKey)
  otherPrivate = (await generateKeyPair('EdDSA', { extractable: true })).privateKey
})

const nowSec = () => Math.floor(Date.now() / 1000)

function sign(body: Record<string, unknown> = {}, opts: { key?: CryptoKey, iss?: string, aud?: string, ttl?: number, iat?: number, jti?: string } = {}) {
  const iat = opts.iat ?? nowSec()
  const exp = iat + (opts.ttl ?? 300)
  const jti = opts.jti ?? `jti-${Math.random().toString(36).slice(2)}`
  const iss = opts.iss ?? 'contentrain-migrate'
  const aud = opts.aud ?? 'contentrain-studio'
  return new SignJWT({ iss, aud, jti, iat, exp, github_user_id: '4242', plan: 'pro', ...body })
    .setProtectedHeader({ alg: 'EdDSA' })
    .sign(opts.key ?? privateKey)
}

const validate = (payload: unknown, now: number) => {
  const checked = validateMigrateAccountStateRequest(payload, { now })
  return checked.ok ? { ok: true as const, value: checked.request } : checked
}

describe('bundle pricing', () => {
  it('year 1 is the yearly list price — Studio is never discounted beyond the yearly plan — and an upgrade is the difference', () => {
    expect(bundleYear1Cents('starter')).toBe(9000)
    expect(bundleYear1Cents('pro')).toBe(49000)
    expect(bundleYear1Cents('starter')).toBe(STUDIO_YEARLY_LIST_CENTS.starter)
    expect(bundleYear1Cents('pro')).toBe(STUDIO_YEARLY_LIST_CENTS.pro)
    expect(bundleUpgradeCents('pro', 'starter')).toBe(40000)
    expect(bundleUpgradeCents('starter', 'pro')).toBe(0)
    expect(planCovers('pro', 'starter')).toBe(true)
    expect(planCovers('starter', 'pro')).toBe(false)
  })

  it('the yearly price is explained against monthly × 12 from the plan config, never a literal', () => {
    for (const plan of ['starter', 'pro'] as const) {
      const monthly = PLAN_PRICING[plan].priceMonthly * 100
      expect(monthlyListCents(plan)).toBe(monthly * 12)
      // The claim "N months free compared to monthly" has to stay true: yearly under monthly × 12.
      expect(STUDIO_YEARLY_LIST_CENTS[plan]).toBeLessThan(monthlyListCents(plan))
      const saving = yearlySaving(plan)
      expect(saving.savingCents).toBe(monthlyListCents(plan) - STUDIO_YEARLY_LIST_CENTS[plan])
      expect(saving.monthsFree).toBe(Math.floor(saving.savingCents / monthly))
      expect(saving.monthsFree).toBeGreaterThan(0)
    }
    expect(yearlySaving('starter')).toEqual({ savingCents: 1800, monthsFree: 2 })
    expect(yearlySaving('pro')).toEqual({ savingCents: 9800, monthsFree: 2 })
  })
})

describe('verifyMigrateS2sRequest', () => {
  const seen = new Set<string>()
  const claimJti = vi.fn(async (jti: string, purpose: string) => {
    const key = `${purpose}:${jti}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  const reason = async (promise: Promise<unknown>) => {
    try {
      await promise
      return 'accepted'
    }
    catch (err) {
      return err instanceof MigrateS2sError ? err.reason : 'other'
    }
  }
  const verify = (token: string) => verifyMigrateS2sRequest(token, publicPem, 'account-state', validate, claimJti)

  beforeEach(() => {
    seen.clear()
    claimJti.mockClear()
  })

  it('accepts a request Migrate signed and returns it', async () => {
    const request = await verify(await sign({ github_user_id: '99' }))
    expect(request).toMatchObject({ github_user_id: '99', plan: 'pro' })
  })

  it('refuses a replay of the same jti (the verifier keys the store by jti and purpose; the real table is keyed by jti alone, so it refuses across purposes too)', async () => {
    const token = await sign({}, { jti: 'once' })
    expect(await reason(verify(token))).toBe('accepted')
    expect(await reason(verify(token))).toBe('replayed')
    expect(await reason(verifyMigrateS2sRequest(token, publicPem, 'provision', validate, claimJti))).toBe('accepted')
  })

  it('does not burn the jti of a request that is wrong anyway', async () => {
    const bad = await sign({ plan: 'enterprise' }, { jti: 'bad' })
    expect(await reason(verify(bad))).toBe('invalid')
    expect(claimJti).not.toHaveBeenCalled()
  })

  it('refuses another key, another audience or issuer, and a lifetime past the contract', async () => {
    expect(await reason(verify(await sign({}, { key: otherPrivate })))).toBe('invalid')
    expect(await reason(verify(await sign({}, { aud: 'contentrain-cms' })))).toBe('invalid')
    expect(await reason(verify(await sign({}, { iss: 'someone-else' })))).toBe('invalid')
    expect(await reason(verify(await sign({}, { ttl: 7 * 24 * 3600 })))).toBe('invalid')
  })

  it('reports an old request as expired', async () => {
    expect(await reason(verify(await sign({}, { iat: nowSec() - 1200, ttl: 600 })))).toBe('expired')
  })
})

describe('POST /api/migrate/account-state', () => {
  let db: Record<string, ReturnType<typeof vi.fn>>
  let auth: Record<string, ReturnType<typeof vi.fn>>
  const planSource = { value: 'subscription' }
  const account = (plan: string, status = 'active') => ({
    subscription_id: 'sub_1',
    subscription_status: status,
    current_period_end: new Date(Date.now() + 86_400_000 * 30).toISOString(),
    trial_ends_at: null,
    grace_period_ends_at: null,
    cancel_at_period_end: false,
    plan,
  })

  beforeEach(() => {
    vi.resetModules()
    vi.doMock('../../server/utils/deployment', () => ({ resolveDeployment: () => ({ planSource: planSource.value }) }))
    const seen = new Set<string>()
    db = {
      claimMigrateS2sJti: vi.fn(async (jti: string) => (seen.has(jti) ? false : (seen.add(jti), true))),
      releaseMigrateS2sJti: vi.fn(async (jti: string) => { seen.delete(jti) }),
      listOwnedWorkspacesAdmin: vi.fn().mockResolvedValue([]),
      getActivePaymentAccount: vi.fn().mockResolvedValue(null),
    }
    auth = { getUserByProviderAccount: vi.fn().mockResolvedValue({ id: 'user-1' }) }
    vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
    vi.stubGlobal('createError', createErrorLike)
    vi.stubGlobal('errorMessage', vi.fn((key: string) => key))
    vi.stubGlobal('useRuntimeConfig', vi.fn().mockReturnValue({ migrate: { claimPublicKey: publicPem } }))
    vi.stubGlobal('useDatabaseProvider', vi.fn(() => db))
    vi.stubGlobal('useAuthProvider', vi.fn(() => auth))
  })

  afterEach(() => {
    vi.doUnmock('../../server/utils/deployment')
    vi.unstubAllGlobals()
  })

  const call = async (body: unknown) => {
    vi.stubGlobal('readBody', vi.fn().mockResolvedValue(body))
    return (await import('../../server/api/migrate/account-state.post')).default({} as never)
  }
  const ask = async (plan: 'starter' | 'pro' = 'pro') => call({ token: await sign({ plan }) })
  const failure = async (promise: Promise<unknown>) => promise.then(() => null, (e: { statusCode: number }) => e.statusCode)

  it('none: no Studio account behind that GitHub user prices year 1 of the sized plan', async () => {
    auth.getUserByProviderAccount.mockResolvedValue(null)
    expect(await ask('pro')).toEqual({ state: 'none', plan: 'pro', year1_cents: 49000, renewal_cents: 49000, monthly_list_cents: PLAN_PRICING.pro.priceMonthly * 1200 })
    expect(auth.getUserByProviderAccount).toHaveBeenCalledWith('github', '4242')
  })

  it('contract: every answer passes the @contentrain/types check Migrate runs, with the S2S shape unchanged (year 1 = the renewal list price)', async () => {
    // `none`: year 1 is the list price, so it equals the renewal; monthly × 12 is above it (the struck price Migrate shows).
    auth.getUserByProviderAccount.mockResolvedValue(null)
    const none = await ask('starter') as Record<string, number | string>
    expect(validateMigrateAccountStateResponse(none, { requested: 'starter' })).toEqual({ ok: true, response: none })
    expect(Object.keys(none).sort()).toEqual(['monthly_list_cents', 'plan', 'renewal_cents', 'state', 'year1_cents'])
    expect(none.year1_cents).toBe(none.renewal_cents)
    expect(none.monthly_list_cents).toBeGreaterThan(none.year1_cents as number)
    // `covers`: nothing added.
    auth.getUserByProviderAccount.mockResolvedValue({ id: 'user-1' })
    db.listOwnedWorkspacesAdmin.mockResolvedValue([{ id: 'ws-1', type: 'primary', plan: 'pro' }])
    db.getActivePaymentAccount.mockResolvedValue(account('pro'))
    const covers = await ask('starter') as Record<string, number | string>
    expect(validateMigrateAccountStateResponse(covers, { requested: 'starter' })).toEqual({ ok: true, response: covers })
    expect(Object.keys(covers).sort()).toEqual(['current_plan', 'monthly_list_cents', 'plan', 'renewal_cents', 'state', 'year1_cents'])
    // `too_small`: the difference of the two list prices; the renewal is the sized plan's list.
    db.listOwnedWorkspacesAdmin.mockResolvedValue([{ id: 'ws-1', type: 'primary', plan: 'starter' }])
    db.getActivePaymentAccount.mockResolvedValue(account('starter'))
    const tooSmall = await ask('pro') as Record<string, number | string>
    expect(validateMigrateAccountStateResponse(tooSmall, { requested: 'pro' })).toEqual({ ok: true, response: tooSmall })
    expect(tooSmall.year1_cents).toBe(49000 - 9000)
    expect(tooSmall.renewal_cents).toBe(49000)
  })

  it('none: an account without a running paid plan (free workspace, trial) adds the full line', async () => {
    db.listOwnedWorkspacesAdmin.mockResolvedValue([{ id: 'ws-free', type: 'primary', plan: 'free' }, { id: 'ws-trial', type: 'secondary', plan: 'pro' }])
    db.getActivePaymentAccount.mockImplementation(async (id: string) => (id === 'ws-trial' ? { ...account('pro', 'trialing'), trial_ends_at: new Date(Date.now() + 86_400_000).toISOString() } : null))
    expect(await ask('starter')).toEqual({ state: 'none', plan: 'starter', year1_cents: 9000, renewal_cents: 9000, monthly_list_cents: 10800 })
  })

  it('covers: a running plan at least the sized one adds nothing and reports the account\'s own plan', async () => {
    db.listOwnedWorkspacesAdmin.mockResolvedValue([{ id: 'ws-1', type: 'secondary', plan: 'pro' }])
    db.getActivePaymentAccount.mockResolvedValue(account('pro'))
    expect(await ask('starter')).toEqual({ state: 'covers', plan: 'pro', year1_cents: 0, renewal_cents: 0, monthly_list_cents: 10800, current_plan: 'pro' })
  })

  it('none: a plan that is ending (cancel_at_period_end) is not Studio included — the normal bundle applies', async () => {
    db.listOwnedWorkspacesAdmin.mockResolvedValue([{ id: 'ws-1', type: 'primary', plan: 'pro' }])
    db.getActivePaymentAccount.mockResolvedValue({ ...account('pro'), cancel_at_period_end: true })
    expect(await ask('starter')).toMatchObject({ state: 'none', plan: 'starter', year1_cents: 9000 })
  })

  it('none: a past_due or canceled plan is not Studio included either', async () => {
    db.listOwnedWorkspacesAdmin.mockResolvedValue([{ id: 'ws-1', type: 'primary', plan: 'pro' }])
    for (const status of ['past_due', 'canceled']) {
      db.getActivePaymentAccount.mockResolvedValue(account('pro', status))
      expect(await ask('starter')).toMatchObject({ state: 'none', plan: 'starter' })
    }
  })

  it('too_small: a running plan below the sized one charges the difference', async () => {
    db.listOwnedWorkspacesAdmin.mockResolvedValue([{ id: 'ws-1', type: 'secondary', plan: 'starter' }])
    db.getActivePaymentAccount.mockResolvedValue(account('starter'))
    expect(await ask('pro')).toEqual({ state: 'too_small', plan: 'pro', year1_cents: 40000, renewal_cents: 49000, monthly_list_cents: PLAN_PRICING.pro.priceMonthly * 1200, current_plan: 'starter' })
  })

  it('coveringWorkspace: the personal workspace if its plan covers, else the first covering one, nothing when none does', async () => {
    const { coveringWorkspace } = await import('../../server/utils/migrate-account-state')
    db.getWorkspaceById = vi.fn(async (id: string) => ({ id, slug: `slug-${id}` }))
    db.listOwnedWorkspacesAdmin.mockResolvedValue([
      { id: 'team', type: 'secondary', plan: 'pro' },
      { id: 'home', type: 'primary', plan: 'pro' },
      { id: 'small', type: 'secondary', plan: 'starter' },
    ])
    db.getActivePaymentAccount.mockImplementation(async (id: string) => account(id === 'small' ? 'starter' : 'pro'))
    expect(await coveringWorkspace('user-1', 'pro')).toEqual({ id: 'home', slug: 'slug-home' })
    db.getActivePaymentAccount.mockImplementation(async (id: string) => (id === 'small' ? account('starter') : id === 'team' ? account('pro') : null))
    expect(await coveringWorkspace('user-1', 'pro')).toEqual({ id: 'team', slug: 'slug-team' })
    expect(await coveringWorkspace('user-1', 'starter')).toEqual({ id: 'team', slug: 'slug-team' })
    db.getActivePaymentAccount.mockImplementation(async (id: string) => (id === 'small' ? account('starter') : null))
    expect(await coveringWorkspace('user-1', 'pro')).toBeNull()
  })

  it('gives the jti back when our own work fails, so Migrate\'s retry of the same request is taken', async () => {
    const token = await sign({ plan: 'pro' })
    auth.getUserByProviderAccount.mockRejectedValueOnce(new Error('db down'))
    await expect(call({ token })).rejects.toThrow('db down')
    expect(db.releaseMigrateS2sJti).toHaveBeenCalledTimes(1)
    expect(await call({ token })).toMatchObject({ state: 'none', plan: 'pro' })
  })

  it('takes the highest running plan across the user\'s workspaces', async () => {
    db.listOwnedWorkspacesAdmin.mockResolvedValue([{ id: 'a', type: 'secondary', plan: 'starter' }, { id: 'b', type: 'secondary', plan: 'pro' }])
    db.getActivePaymentAccount.mockImplementation(async (id: string) => account(id === 'a' ? 'starter' : 'pro'))
    expect(await ask('pro')).toMatchObject({ state: 'covers', current_plan: 'pro' })
  })

  it('refuses a replayed request, a bad body, a forged one, and answers 404 when Migrate is not configured', async () => {
    const token = await sign({ plan: 'pro' })
    expect(await failure(call({ token }))).toBeNull()
    expect(await failure(call({ token }))).toBe(409)
    expect(await failure(call({}))).toBe(400)
    expect(await failure(call({ token: await sign({}, { key: otherPrivate }) }))).toBe(400)
    expect(await failure(call({ token: await sign({}, { iat: nowSec() - 1200, ttl: 600 }) }))).toBe(410)

    vi.stubGlobal('useRuntimeConfig', vi.fn().mockReturnValue({ migrate: {} }))
    expect(await failure(call({ token: await sign() }))).toBe(404)
  })
})

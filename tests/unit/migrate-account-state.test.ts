import { exportSPKI, generateKeyPair, SignJWT } from 'jose'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { validateMigrateAccountStateRequest } from '@contentrain/types'
import { MigrateS2sError, verifyMigrateS2sRequest } from '../../server/utils/migrate-s2s'
import { bundleUpgradeCents, bundleYear1Cents, planCovers } from '../../shared/utils/migrate-bundle'

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
  it('year 1 is 20% off the yearly list price, and an upgrade is the difference', () => {
    expect(bundleYear1Cents('starter')).toBe(7200)
    expect(bundleYear1Cents('pro')).toBe(39200)
    expect(bundleUpgradeCents('pro', 'starter')).toBe(32000)
    expect(bundleUpgradeCents('starter', 'pro')).toBe(0)
    expect(planCovers('pro', 'starter')).toBe(true)
    expect(planCovers('starter', 'pro')).toBe(false)
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
    expect(await ask('pro')).toEqual({ state: 'none', plan: 'pro', year1_cents: 39200, renewal_cents: 49000 })
    expect(auth.getUserByProviderAccount).toHaveBeenCalledWith('github', '4242')
  })

  it('none: an account without a running paid plan (free workspace, trial) adds the full line', async () => {
    db.listOwnedWorkspacesAdmin.mockResolvedValue([{ id: 'ws-free', type: 'primary', plan: 'free' }, { id: 'ws-trial', type: 'secondary', plan: 'pro' }])
    db.getActivePaymentAccount.mockImplementation(async (id: string) => (id === 'ws-trial' ? { ...account('pro', 'trialing'), trial_ends_at: new Date(Date.now() + 86_400_000).toISOString() } : null))
    expect(await ask('starter')).toEqual({ state: 'none', plan: 'starter', year1_cents: 7200, renewal_cents: 9000 })
  })

  it('covers: a running plan at least the sized one adds nothing and reports the account\'s own plan', async () => {
    db.listOwnedWorkspacesAdmin.mockResolvedValue([{ id: 'ws-1', type: 'secondary', plan: 'pro' }])
    db.getActivePaymentAccount.mockResolvedValue(account('pro'))
    expect(await ask('starter')).toEqual({ state: 'covers', plan: 'pro', year1_cents: 0, renewal_cents: 0, current_plan: 'pro' })
  })

  it('too_small: a running plan below the sized one charges the difference', async () => {
    db.listOwnedWorkspacesAdmin.mockResolvedValue([{ id: 'ws-1', type: 'secondary', plan: 'starter' }])
    db.getActivePaymentAccount.mockResolvedValue(account('starter'))
    expect(await ask('pro')).toEqual({ state: 'too_small', plan: 'pro', year1_cents: 32000, renewal_cents: 49000, current_plan: 'starter' })
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

import { exportSPKI, generateKeyPair, SignJWT } from 'jose'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { MIGRATE_STUDIO_CLAIM_AUDIENCE, MIGRATE_STUDIO_CLAIM_ISSUER } from '@contentrain/types'

vi.mock('../../server/utils/deployment', () => ({ resolveDeployment: () => ({ planSource: 'subscription' }) }))

let privateKey: CryptoKey
let publicPem: string
const nowSec = () => Math.floor(Date.now() / 1000)
let counter = 0

const sign = (body: Record<string, unknown> = {}, key = privateKey) => {
  const iat = nowSec()
  return new SignJWT({
    iss: MIGRATE_STUDIO_CLAIM_ISSUER, aud: MIGRATE_STUDIO_CLAIM_AUDIENCE, jti: `jti-${++counter}`, iat, exp: iat + 300, order_id: 'ord_123', reason: 'refund_before_delivery', ...body,
  }).setProtectedHeader({ alg: 'EdDSA' }).sign(key)
}

const grant = (over: Record<string, unknown> = {}) => ({
  id: 'grant-1', order_id: 'ord_123', kind: 'bundle', user_id: 'user-1', workspace_id: 'ws-1',
  bound_at: '2026-10-03T10:00:00Z', redeemed_at: '2026-10-03T10:05:00Z', redeemed_subscription_id: 'sub_bound',
  revoked_at: null, revoked_reason: null, ...over,
})

beforeAll(async () => {
  const pair = await generateKeyPair('EdDSA', { extractable: true })
  privateKey = pair.privateKey
  publicPem = await exportSPKI(pair.publicKey)
})

describe('POST /api/migrate/grants/revoke', () => {
  let db: Record<string, ReturnType<typeof vi.fn>>
  let payment: { cancelSubscription: ReturnType<typeof vi.fn> } | null
  let body: unknown
  const taken = new Set<string>()
  const config = { migrate: { claimPublicKey: '' } }

  const call = async () => ((await import('../../server/api/migrate/grants/revoke.post')).default as (e: unknown) => Promise<unknown>)({})
  const request = async (over?: Record<string, unknown>) => {
    body = { token: await sign(over) }
  }

  beforeEach(() => {
    vi.resetModules()
    taken.clear()
    config.migrate.claimPublicKey = publicPem
    payment = { cancelSubscription: vi.fn().mockResolvedValue('canceled') }
    db = {
      getMigrateGrantByOrderId: vi.fn().mockResolvedValue(grant()),
      getWorkspaceById: vi.fn().mockResolvedValue({ id: 'ws-1', github_installation_id: null }),
      markMigrateGrantRevoked: vi.fn().mockResolvedValue(null),
      getActivePaymentAccount: vi.fn().mockResolvedValue(null),
      releaseMigrateS2sJti: vi.fn().mockResolvedValue(undefined),
      claimMigrateS2sJti: vi.fn(async (jti: string, purpose: string) => {
        if (taken.has(`${purpose}:${jti}`)) return false
        taken.add(`${purpose}:${jti}`)
        return true
      }),
    }
    vi.stubGlobal('defineEventHandler', (h: unknown) => h)
    vi.stubGlobal('readBody', () => Promise.resolve(body))
    vi.stubGlobal('useRuntimeConfig', () => config)
    vi.stubGlobal('useDatabaseProvider', () => db)
    vi.stubGlobal('usePaymentProvider', () => payment)
    vi.stubGlobal('errorMessage', (key: string) => key)
  })

  it('cancels the plan\'s usage subscription (the companion of a yearly plan) before the plan itself', async () => {
    db.getActivePaymentAccount.mockResolvedValue({ plugin_metadata: { companion_subscription_id: 'sub_companion' } })
    await request()
    expect(await call()).toEqual({ state: 'revoked', installed: false, subscription_canceled: true })
    expect(payment!.cancelSubscription.mock.calls.map(c => c[0])).toEqual(['sub_companion', 'sub_bound'])
    expect(db.markMigrateGrantRevoked).toHaveBeenCalledWith('grant-1', 'refund_before_delivery')
  })

  it('a companion that cannot be cancelled leaves the grant live and the plan untouched, so Migrate can call again', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    db.getActivePaymentAccount.mockResolvedValue({ plugin_metadata: { companion_subscription_id: 'sub_companion' } })
    payment!.cancelSubscription.mockRejectedValueOnce(new Error('polar down'))
    await request()
    await expect(call()).rejects.toMatchObject({ statusCode: 502 })
    expect(payment!.cancelSubscription).toHaveBeenCalledTimes(1)
    expect(db.markMigrateGrantRevoked).not.toHaveBeenCalled()
    log.mockRestore()
  })

  it('cancels the subscription the grant is bound to, marks the grant, and keeps the installed fact', async () => {
    db.getWorkspaceById.mockResolvedValue({ id: 'ws-1', github_installation_id: 4242 })
    await request()
    expect(await call()).toEqual({ state: 'revoked', installed: true, subscription_canceled: true })
    expect(payment!.cancelSubscription).toHaveBeenCalledOnce()
    expect(payment!.cancelSubscription).toHaveBeenCalledWith('sub_bound')
    expect(db.markMigrateGrantRevoked).toHaveBeenCalledWith('grant-1', 'refund_before_delivery')
  })

  it('records the reason Migrate gave', async () => {
    await request({ reason: 'delivery_failed' })
    await call()
    expect(db.markMigrateGrantRevoked).toHaveBeenCalledWith('grant-1', 'delivery_failed')
  })

  it('never reads a payment id from the request: a refunded duplicate payment cannot revoke or cancel anything else', async () => {
    // A second checkout's subscription never became the grant's (isDuplicateBundleSubscription);
    // an id smuggled into the request is ignored, only the bound subscription is cancelled.
    await request({ subscription_id: 'sub_duplicate', payment_id: 'pay_duplicate' })
    await call()
    expect(payment!.cancelSubscription).toHaveBeenCalledTimes(1)
    expect(payment!.cancelSubscription).toHaveBeenCalledWith('sub_bound')
  })

  it('revokes a grant that never ran a subscription without calling Polar', async () => {
    db.getMigrateGrantByOrderId.mockResolvedValue(grant({ redeemed_at: null, redeemed_subscription_id: null }))
    await request()
    expect(await call()).toEqual({ state: 'revoked', installed: false, subscription_canceled: false })
    expect(payment!.cancelSubscription).not.toHaveBeenCalled()
    expect(db.markMigrateGrantRevoked).toHaveBeenCalledOnce()
  })

  it('is idempotent: a repeat on a revoked grant cancels nothing and answers revoked', async () => {
    db.getMigrateGrantByOrderId.mockResolvedValue(grant({ revoked_at: '2026-10-03T11:00:00Z', revoked_reason: 'ops' }))
    await request()
    expect(await call()).toEqual({ state: 'revoked', installed: false, subscription_canceled: false })
    expect(payment!.cancelSubscription).not.toHaveBeenCalled()
    expect(db.markMigrateGrantRevoked).not.toHaveBeenCalled()
  })

  it('treats a subscription Polar already ended as done: grant revoked, nothing canceled, no 502 loop', async () => {
    payment!.cancelSubscription.mockResolvedValue('already_ended')
    await request()
    expect(await call()).toEqual({ state: 'revoked', installed: false, subscription_canceled: false })
    expect(db.markMigrateGrantRevoked).toHaveBeenCalledWith('grant-1', 'refund_before_delivery')
    expect(db.releaseMigrateS2sJti).not.toHaveBeenCalled()
  })

  it('leaves the grant live and gives the token back when Polar fails, so Migrate can retry', async () => {
    payment!.cancelSubscription.mockRejectedValue(new Error('polar down'))
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await request()
    await expect(call()).rejects.toMatchObject({ statusCode: 502, message: 'billing.provider_unavailable' })
    expect(db.markMigrateGrantRevoked).not.toHaveBeenCalled()
    expect(db.releaseMigrateS2sJti).toHaveBeenCalledOnce()
  })

  it('does not give the token back for a 404', async () => {
    db.getMigrateGrantByOrderId.mockResolvedValue(null)
    await request()
    await expect(call()).rejects.toMatchObject({ statusCode: 404, message: 'migrate.grant_not_found' })
    expect(db.releaseMigrateS2sJti).not.toHaveBeenCalled()
  })

  it('refuses an unsigned, foreign-signed, replayed or reasonless request, and is off without Migrate\'s key', async () => {
    body = { token: 'x.y.z' }
    await expect(call()).rejects.toMatchObject({ statusCode: 400 })
    body = { token: await sign({}, (await generateKeyPair('EdDSA')).privateKey) }
    await expect(call()).rejects.toMatchObject({ statusCode: 400 })
    await request({ reason: 'because' })
    await expect(call()).rejects.toMatchObject({ statusCode: 400 })

    await request()
    await call()
    await expect(call()).rejects.toMatchObject({ statusCode: 409 })

    config.migrate.claimPublicKey = ''
    await request()
    await expect(call()).rejects.toMatchObject({ statusCode: 404 })
    expect(payment!.cancelSubscription).toHaveBeenCalledTimes(1)
  })

  it('spends the token under its own purpose', async () => {
    await request()
    await call()
    expect([...taken]).toEqual([expect.stringMatching(/^revoke:/)])
  })

  describe('a Studio year Migrate collected', () => {
    const prepaidGrant = grant({ collector: 'migrate', redeemed_subscription_id: null, payment_ref: 'txn_1', prepaid_starts_at: '2026-11-04T10:00:00Z', prepaid_ends_at: '2027-11-04T10:00:00Z' })

    beforeEach(() => {
      db.getMigrateGrantByOrderId.mockResolvedValue(prepaidGrant)
      db.updateWorkspace = vi.fn().mockResolvedValue({})
    })

    it('ends the prepaid year on the workspace before marking the grant, and cancels nothing', async () => {
      db.getWorkspaceById.mockResolvedValue({ id: 'ws-1', github_installation_id: null, prepaid_until: '2027-11-04T10:00:00.000Z' })
      await request({ reason: 'studio_not_delivered' })
      expect(await call()).toEqual({ state: 'revoked', installed: false, subscription_canceled: false })
      expect(payment!.cancelSubscription).not.toHaveBeenCalled()
      expect(db.updateWorkspace).toHaveBeenCalledWith('', 'ws-1', { prepaid_until: null, prepaid_plan: null, plan: 'free', trial_reminder_stage: 0 })
      expect(db.updateWorkspace.mock.invocationCallOrder[0]).toBeLessThan(db.markMigrateGrantRevoked.mock.invocationCallOrder[0]!)
      expect(db.markMigrateGrantRevoked).toHaveBeenCalledWith('grant-1', 'studio_not_delivered')
    })

    it('keeps the plan of a subscription the workspace has of its own', async () => {
      db.getWorkspaceById.mockResolvedValue({ id: 'ws-1', github_installation_id: null, prepaid_until: '2027-11-04T10:00:00Z' })
      db.getActivePaymentAccount.mockResolvedValue({ subscription_id: 'sub_own' })
      await request()
      await call()
      expect(db.updateWorkspace).toHaveBeenCalledWith('', 'ws-1', { prepaid_until: null, prepaid_plan: null })
    })

    it('ends a year an activate started after the grant was read: the revoked row carries it', async () => {
      // revoke reads the grant before activate wrote it; activate then starts the year and marks it redeemed.
      db.getMigrateGrantByOrderId.mockResolvedValue(grant({ collector: 'migrate', redeemed_at: null, redeemed_subscription_id: null }))
      db.markMigrateGrantRevoked.mockResolvedValue({ ...prepaidGrant, revoked_at: '2026-11-04T10:01:00Z' })
      db.getWorkspaceById.mockResolvedValue({ id: 'ws-1', github_installation_id: null, prepaid_until: '2027-11-04T10:00:00Z' })
      await request()
      await call()
      expect(db.updateWorkspace).toHaveBeenCalledWith('', 'ws-1', { prepaid_until: null, prepaid_plan: null, plan: 'free', trial_reminder_stage: 0 })
      expect(db.markMigrateGrantRevoked.mock.invocationCallOrder[0]).toBeLessThan(db.updateWorkspace.mock.invocationCallOrder[0]!)
    })

    it('cancels the subscription opened to keep Studio, and the plan still ends with the year', async () => {
      db.getMigrateGrantByOrderId.mockResolvedValue({ ...prepaidGrant, renewal_subscription_id: 'sub_renewal' })
      db.getWorkspaceById.mockResolvedValue({ id: 'ws-1', github_installation_id: null, prepaid_until: '2027-11-04T10:00:00Z' })
      // The renewal is the workspace's account until its cancel webhook lands.
      db.getActivePaymentAccount.mockResolvedValue({ subscription_id: 'sub_renewal', plugin_metadata: { companion_subscription_id: 'sub_companion' } })
      await request()
      expect(await call()).toEqual({ state: 'revoked', installed: false, subscription_canceled: true })
      expect(payment!.cancelSubscription.mock.calls.map(c => c[0])).toEqual(['sub_companion', 'sub_renewal'])
      expect(db.updateWorkspace).toHaveBeenCalledWith('', 'ws-1', { prepaid_until: null, prepaid_plan: null, plan: 'free', trial_reminder_stage: 0 })
    })

    it('a repeat on a revoked grant still takes off a year the first call left (it threw after the mark)', async () => {
      db.getMigrateGrantByOrderId.mockResolvedValue({ ...prepaidGrant, revoked_at: '2026-11-04T10:01:00Z' })
      db.getWorkspaceById.mockResolvedValue({ id: 'ws-1', github_installation_id: null, prepaid_until: '2027-11-04T10:00:00Z' })
      await request()
      expect(await call()).toEqual({ state: 'revoked', installed: false, subscription_canceled: false })
      expect(db.updateWorkspace).toHaveBeenCalledWith('', 'ws-1', { prepaid_until: null, prepaid_plan: null, plan: 'free', trial_reminder_stage: 0 })
      expect(db.markMigrateGrantRevoked).not.toHaveBeenCalled()
    })

    it('leaves a workspace alone that no longer holds this grant\'s year', async () => {
      db.getWorkspaceById.mockResolvedValue({ id: 'ws-1', github_installation_id: null, prepaid_until: '2028-01-01T00:00:00Z' })
      await request()
      await call()
      expect(db.updateWorkspace).not.toHaveBeenCalled()
      expect(db.markMigrateGrantRevoked).toHaveBeenCalled()
    })
  })
})

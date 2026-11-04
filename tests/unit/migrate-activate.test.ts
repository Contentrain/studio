import { exportSPKI, generateKeyPair, SignJWT } from 'jose'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { MIGRATE_PREPAID_YEAR_SECONDS, MIGRATE_STUDIO_CLAIM_AUDIENCE, MIGRATE_STUDIO_CLAIM_ISSUER } from '@contentrain/types'

vi.mock('../../server/utils/deployment', () => ({ resolveDeployment: () => ({ planSource: 'subscription' }) }))

function createErrorLike(input: { statusCode: number, message: string, data?: unknown }) {
  return Object.assign(new Error(input.message), input)
}

const PAID_AT = Math.floor(new Date('2026-11-04T10:00:00Z').getTime() / 1000)
const ENDS_AT = PAID_AT + MIGRATE_PREPAID_YEAR_SECONDS
const iso = (sec: number) => new Date(sec * 1000).toISOString()

const request = (payment: Record<string, unknown> = {}) => ({
  iss: MIGRATE_STUDIO_CLAIM_ISSUER, aud: MIGRATE_STUDIO_CLAIM_AUDIENCE, jti: 'jti-1', iat: PAID_AT, exp: PAID_AT + 300, order_id: 'ord_1',
  payment: { provider: 'paddle', transaction_id: 'txn_1', paid_at: PAID_AT, studio_amount_cents: 49000, currency: 'usd', ...payment },
})

const reserved = (over: Record<string, unknown> = {}) => ({
  id: 'grant-1', order_id: 'ord_1', kind: 'bundle', collector: 'migrate', plan: 'pro', user_id: 'user-1',
  workspace_id: 'ws-1', bound_at: '2026-11-04T09:50:00Z', redeemed_at: null, redeemed_subscription_id: null,
  revoked_at: null, payment_ref: null, prepaid_starts_at: null, prepaid_ends_at: null, ...over,
})

describe('activateMigrateGrant', () => {
  let db: Record<string, ReturnType<typeof vi.fn>>

  beforeEach(() => {
    vi.resetModules()
    db = {
      getMigrateGrantByOrderId: vi.fn().mockResolvedValue(reserved()),
      getMigrateGrantById: vi.fn().mockResolvedValue(reserved({ payment_ref: 'txn_1' })),
      getWorkspaceById: vi.fn().mockResolvedValue({ id: 'ws-1', slug: 'owner-abc', prepaid_until: null }),
      getActivePaymentAccount: vi.fn().mockResolvedValue(null),
      recordMigrateGrantPrepaid: vi.fn().mockResolvedValue(reserved({ payment_ref: 'txn_1', prepaid_starts_at: iso(PAID_AT), prepaid_ends_at: iso(ENDS_AT) })),
      updateWorkspace: vi.fn().mockResolvedValue({}),
      markMigrateGrantRedeemed: vi.fn().mockResolvedValue(undefined),
    }
    vi.stubGlobal('createError', createErrorLike)
    vi.stubGlobal('errorMessage', (key: string) => key)
    vi.stubGlobal('useDatabaseProvider', () => db)
  })

  const run = async (r = request()) => (await import('../../server/utils/migrate-activate')).activateMigrateGrant(r as never)
  const refusal = async (r = request()) => run(r).then(() => null, (e: { statusCode: number, data?: { code?: string } }) => ({ status: e.statusCode, code: e.data?.code }))

  it('starts the year from the payment: grant first, then the workspace, then redeemed', async () => {
    expect(await run()).toEqual({ state: 'redeemed', plan: 'pro', workspace_slug: 'owner-abc', starts_at: PAID_AT, ends_at: ENDS_AT })
    expect(db.recordMigrateGrantPrepaid).toHaveBeenCalledWith('grant-1', { paymentRef: 'txn_1', startsAt: iso(PAID_AT), endsAt: iso(ENDS_AT) })
    expect(db.updateWorkspace).toHaveBeenCalledWith('', 'ws-1', { prepaid_until: iso(ENDS_AT), prepaid_plan: 'pro', plan: 'pro' })
    expect(db.markMigrateGrantRedeemed).toHaveBeenCalledWith('grant-1', null)
    const order = [db.recordMigrateGrantPrepaid, db.updateWorkspace, db.markMigrateGrantRedeemed].map(f => f.mock.invocationCallOrder[0]!)
    expect(order).toEqual([...order].sort((a, b) => a - b))
  })

  it('the same transaction again answers the stored year and writes nothing', async () => {
    db.getMigrateGrantByOrderId.mockResolvedValue(reserved({ redeemed_at: '2026-11-04T10:01:00Z', payment_ref: 'txn_1', prepaid_starts_at: iso(PAID_AT), prepaid_ends_at: iso(ENDS_AT) }))
    expect(await run()).toMatchObject({ state: 'redeemed', starts_at: PAID_AT, ends_at: ENDS_AT })
    expect(db.recordMigrateGrantPrepaid).not.toHaveBeenCalled()
    expect(db.updateWorkspace).not.toHaveBeenCalled()
  })

  it('finishes a first call that stopped after the workspace write, without refusing its own year', async () => {
    db.getMigrateGrantByOrderId.mockResolvedValue(reserved({ payment_ref: 'txn_1', prepaid_starts_at: iso(PAID_AT), prepaid_ends_at: iso(ENDS_AT) }))
    db.getWorkspaceById.mockResolvedValue({ id: 'ws-1', slug: 'owner-abc', prepaid_until: iso(ENDS_AT) })
    expect(await run()).toMatchObject({ state: 'redeemed', ends_at: ENDS_AT })
    expect(db.markMigrateGrantRedeemed).toHaveBeenCalled()
  })

  it('refuses another transaction for a paid grant, and never starts a second year', async () => {
    db.getMigrateGrantByOrderId.mockResolvedValue(reserved({ redeemed_at: '2026-11-04T10:01:00Z', payment_ref: 'txn_1' }))
    expect(await refusal(request({ transaction_id: 'txn_2' }))).toEqual({ status: 409, code: 'already_active' })
    expect(db.recordMigrateGrantPrepaid).not.toHaveBeenCalled()
  })

  it('the order\'s own payment after a revoke answers revoked; another one is refused', async () => {
    db.getMigrateGrantByOrderId.mockResolvedValue(reserved({ revoked_at: '2026-11-04T09:55:00Z' }))
    expect(await run()).toEqual({ state: 'revoked' })
    db.getMigrateGrantByOrderId.mockResolvedValue(reserved({ revoked_at: '2026-11-04T09:55:00Z', payment_ref: 'txn_1' }))
    expect(await refusal(request({ transaction_id: 'txn_2' }))).toEqual({ status: 409, code: 'grant_revoked' })
    expect(db.updateWorkspace).not.toHaveBeenCalled()
  })

  it('refuses a workspace that took a subscription or a prepaid year since the reservation', async () => {
    db.getActivePaymentAccount.mockResolvedValue({ subscription_id: 'sub_1', subscription_status: 'active' })
    expect(await refusal()).toEqual({ status: 409, code: 'subscription_exists' })
    db.getActivePaymentAccount.mockResolvedValue(null)
    db.getWorkspaceById.mockResolvedValue({ id: 'ws-1', slug: 'owner-abc', prepaid_until: '2099-01-01T00:00:00Z' })
    expect(await refusal()).toEqual({ status: 409, code: 'subscription_exists' })
    expect(db.recordMigrateGrantPrepaid).not.toHaveBeenCalled()
  })

  it('refuses a Studio part that is not the year Studio reserved, a covered order and a Polar grant', async () => {
    expect(await refusal(request({ studio_amount_cents: 9000 }))).toEqual({ status: 409, code: 'amount_mismatch' })
    db.getMigrateGrantByOrderId.mockResolvedValue(reserved({ redeemed_at: '2026-11-04T09:00:00Z' }))
    expect(await refusal()).toEqual({ status: 409, code: 'covered' })
    db.getMigrateGrantByOrderId.mockResolvedValue(reserved({ collector: 'studio_polar' }))
    expect(await refusal()).toEqual({ status: 409, code: 'not_migrate_collected' })
    expect(db.recordMigrateGrantPrepaid).not.toHaveBeenCalled()
  })

  it('takes the year back off when a revoke landed between the writes', async () => {
    db.getMigrateGrantById.mockResolvedValue(reserved({ payment_ref: 'txn_1', revoked_at: '2026-11-04T10:00:30Z' }))
    expect(await run()).toEqual({ state: 'revoked' })
    expect(db.updateWorkspace).toHaveBeenLastCalledWith('', 'ws-1', { prepaid_until: null, prepaid_plan: null })
    expect(db.markMigrateGrantRedeemed).not.toHaveBeenCalled()
  })

  it('is a 404 for an order Studio holds no grant for', async () => {
    db.getMigrateGrantByOrderId.mockResolvedValue(null)
    expect(await refusal()).toEqual({ status: 404, code: undefined })
  })
})

describe('POST /api/migrate/grants/activate', () => {
  let privateKey: CryptoKey
  let publicPem: string
  let body: unknown
  let db: Record<string, ReturnType<typeof vi.fn>>
  const taken = new Set<string>()
  const activateMigrateGrant = vi.fn()

  beforeAll(async () => {
    const pair = await generateKeyPair('EdDSA', { extractable: true })
    privateKey = pair.privateKey
    publicPem = await exportSPKI(pair.publicKey)
  })

  beforeEach(() => {
    vi.resetModules()
    taken.clear()
    activateMigrateGrant.mockReset().mockResolvedValue({ state: 'revoked' })
    vi.doMock('../../server/utils/migrate-activate', () => ({ activateMigrateGrant }))
    db = {
      releaseMigrateS2sJti: vi.fn().mockResolvedValue(undefined),
      claimMigrateS2sJti: vi.fn(async (jti: string, purpose: string) => {
        if (taken.has(`${purpose}:${jti}`)) return false
        taken.add(`${purpose}:${jti}`)
        return true
      }),
    }
    vi.stubGlobal('defineEventHandler', (h: unknown) => h)
    vi.stubGlobal('readBody', () => Promise.resolve(body))
    vi.stubGlobal('useRuntimeConfig', () => ({ migrate: { claimPublicKey: publicPem } }))
    vi.stubGlobal('useDatabaseProvider', () => db)
    vi.stubGlobal('createError', createErrorLike)
    vi.stubGlobal('errorMessage', (key: string) => key)
  })

  const call = async () => ((await import('../../server/api/migrate/grants/activate.post')).default as (e: unknown) => Promise<unknown>)({})
  const sign = async (over: Record<string, unknown> = {}) => {
    const now = Math.floor(Date.now() / 1000)
    const payload = { ...request({ paid_at: now - 60 }), iat: now, exp: now + 300, ...over }
    body = { token: await new SignJWT(payload).setProtectedHeader({ alg: 'EdDSA' }).sign(privateKey) }
  }

  it('verifies the signed request, spends its jti under the activate purpose, and activates', async () => {
    await sign()
    expect(await call()).toEqual({ state: 'revoked' })
    expect(activateMigrateGrant).toHaveBeenCalledWith(expect.objectContaining({ order_id: 'ord_1', payment: expect.objectContaining({ transaction_id: 'txn_1' }) }))
    expect([...taken]).toEqual([expect.stringMatching(/^activate:/)])
  })

  it('refuses a request with no payment', async () => {
    await sign({ payment: undefined })
    await expect(call()).rejects.toMatchObject({ statusCode: 400 })
    expect(activateMigrateGrant).not.toHaveBeenCalled()
  })

  it('gives the jti back only when Studio itself failed', async () => {
    await sign()
    activateMigrateGrant.mockRejectedValue(createErrorLike({ statusCode: 409, message: 'x' }))
    await call().catch(() => {})
    expect(db.releaseMigrateS2sJti).not.toHaveBeenCalled()
    await sign({ jti: 'jti-2' })
    activateMigrateGrant.mockRejectedValue(new Error('boom'))
    await call().catch(() => {})
    expect(db.releaseMigrateS2sJti).toHaveBeenCalledWith('jti-2')
  })
})

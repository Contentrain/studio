import { exportSPKI, generateKeyPair, SignJWT } from 'jose'
import { beforeAll, describe, expect, it } from 'vitest'
import { MigrateClaimError, verifyMigrateClaim } from '../../server/utils/migrate-claim'

const claim = {
  v: 1,
  order_id: 'ord_123',
  email: 'owner@example.com',
  plan: 'pro',
  trial_days: 60,
  repo: { provider: 'github', owner: 'acme', name: 'blog' },
  capabilities: [{ key: 'comments', scale: '1 240 comments' }],
  plan_evidence: [{ limit_key: 'comments.per_month', measured: 3200, limit: 500, capability: 'comments' }],
}

let privateKey: CryptoKey
let publicPem: string
let otherPublicPem: string

beforeAll(async () => {
  const pair = await generateKeyPair('EdDSA', { extractable: true })
  privateKey = pair.privateKey
  publicPem = await exportSPKI(pair.publicKey)
  otherPublicPem = await exportSPKI((await generateKeyPair('EdDSA', { extractable: true })).publicKey)
})

function sign(payload: Record<string, unknown> = claim, opts: { iss?: string, aud?: string, ttl?: number, iat?: number, jti?: string | null, sub?: string | null } = {}) {
  const iat = opts.iat ?? Math.floor(Date.now() / 1000)
  const jwt = new SignJWT(payload)
    .setProtectedHeader({ alg: 'EdDSA' })
    .setIssuer(opts.iss ?? 'contentrain-migrate')
    .setAudience(opts.aud ?? 'contentrain-studio')
    .setIssuedAt(iat)
    .setExpirationTime(iat + (opts.ttl ?? 900))
  if (opts.jti !== null) jwt.setJti(opts.jti ?? 'jti-1')
  if (opts.sub !== null) jwt.setSubject(opts.sub ?? 'migrate-user-1')
  return jwt.sign(privateKey)
}

async function reason(promise: Promise<unknown>) {
  try {
    await promise
    return 'accepted'
  }
  catch (err) {
    return err instanceof MigrateClaimError ? err.reason : 'other'
  }
}

describe('verifyMigrateClaim', () => {
  it('accepts a claim Migrate signed, and returns what it says', async () => {
    const verified = await verifyMigrateClaim(await sign(), publicPem)
    expect(verified.claim).toMatchObject({ order_id: 'ord_123', plan: 'pro', trial_days: 60, repo: { owner: 'acme', name: 'blog' } })
    expect(verified.jti).toBe('jti-1')
    expect(verified.subject).toBe('migrate-user-1')
  })

  it('refuses a claim signed by another key', async () => {
    expect(await reason(verifyMigrateClaim(await sign(), otherPublicPem))).toBe('invalid')
  })

  it('reports an expired link as expired', async () => {
    const iat = Math.floor(Date.now() / 1000) - 1200
    expect(await reason(verifyMigrateClaim(await sign(claim, { iat, ttl: 600 }), publicPem))).toBe('expired')
  })

  it('refuses a token meant for someone else or from someone else', async () => {
    expect(await reason(verifyMigrateClaim(await sign(claim, { aud: 'contentrain-cms' }), publicPem))).toBe('invalid')
    expect(await reason(verifyMigrateClaim(await sign(claim, { iss: 'someone-else' }), publicPem))).toBe('invalid')
  })

  it('refuses a token that would live longer than the contract allows', async () => {
    expect(await reason(verifyMigrateClaim(await sign(claim, { ttl: 7 * 24 * 3600 }), publicPem))).toBe('invalid')
  })

  it('refuses a token without a jti or a Migrate user', async () => {
    expect(await reason(verifyMigrateClaim(await sign(claim, { jti: null }), publicPem))).toBe('invalid')
    expect(await reason(verifyMigrateClaim(await sign(claim, { sub: null }), publicPem))).toBe('invalid')
  })

  it('checks the signed body against the shared contract', async () => {
    const refused = [
      { ...claim, v: 2 },
      { ...claim, trial_days: 1.5 },
      { ...claim, order_id: ' ' },
      { ...claim, repo: { provider: 'gitlab', owner: 'a', name: 'b' } },
      { ...claim, repo: { provider: 'github', owner: 'a/b', name: 'c' } },
      { ...claim, plan_evidence: undefined },
      { ...claim, plan_evidence: [{ limit_key: 'x', measured: 'lots', limit: 1 }] },
      { ...claim, capabilities: [{ key: 'teleport' }] },
    ]
    for (const body of refused)
      expect(await reason(verifyMigrateClaim(await sign(body), publicPem))).toBe('invalid')
    expect(await reason(verifyMigrateClaim(await sign({ ...claim, plan_evidence: [] }), publicPem))).toBe('accepted')
  })

  it('allows the contract\'s clock skew, and no more', async () => {
    const now = Math.floor(Date.now() / 1000)
    // Expired 30 s ago: within the 60 s skew.
    expect(await reason(verifyMigrateClaim(await sign(claim, { iat: now - 630, ttl: 600 }), publicPem))).toBe('accepted')
    // Issued 30 s "in the future" by a fast Migrate clock.
    expect(await reason(verifyMigrateClaim(await sign(claim, { iat: now + 30, ttl: 600 }), publicPem))).toBe('accepted')
    expect(await reason(verifyMigrateClaim(await sign(claim, { iat: now - 700, ttl: 600 }), publicPem))).toBe('expired')
  })

  it('refuses a trial longer than 90 days, or a plan Studio does not sell', async () => {
    expect(await reason(verifyMigrateClaim(await sign({ ...claim, trial_days: 365 }), publicPem))).toBe('invalid')
    expect(await reason(verifyMigrateClaim(await sign({ ...claim, plan: 'enterprise' }), publicPem))).toBe('invalid')
  })

  it('refuses an HMAC token even if its body is right (algorithm pinned to EdDSA)', async () => {
    const hs = await new SignJWT(claim)
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer('contentrain-migrate')
      .setAudience('contentrain-studio')
      .setIssuedAt()
      .setExpirationTime('10m')
      .setJti('jti-hs')
      .sign(new TextEncoder().encode(publicPem))
    expect(await reason(verifyMigrateClaim(hs, publicPem))).toBe('invalid')
  })
})

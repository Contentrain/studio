import { exportSPKI, generateKeyPair, SignJWT } from 'jose'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { MIGRATE_STUDIO_CLAIM_AUDIENCE, MIGRATE_STUDIO_CLAIM_ISSUER } from '@contentrain/types'
import { verifyMigrateInstallState } from '../../server/utils/migrate-install-state'

vi.mock('../../server/utils/deployment', () => ({ resolveDeployment: () => ({ planSource: 'subscription' }) }))

let privateKey: CryptoKey
let publicPem: string
const stateKey = 'k'.repeat(40)
const nowSec = () => Math.floor(Date.now() / 1000)
let counter = 0

const sign = (body: Record<string, unknown> = {}, key = privateKey) => {
  const iat = nowSec()
  return new SignJWT({
    iss: MIGRATE_STUDIO_CLAIM_ISSUER, aud: MIGRATE_STUDIO_CLAIM_AUDIENCE, jti: `jti-${++counter}`, iat, exp: iat + 300, order_id: 'ord_123', ...body,
  }).setProtectedHeader({ alg: 'EdDSA' }).sign(key)
}

const grant = (over: Record<string, unknown> = {}) => ({
  id: 'grant-1', order_id: 'ord_123', user_id: 'user-1', kind: 'trial', plan: 'pro', trial_days: 60, redeemed_subscription_id: null, workspace_id: 'ws-1', bound_at: '2026-10-03T10:00:00Z', redeemed_at: '2026-10-03T10:05:00Z', ...over,
})

beforeAll(async () => {
  const pair = await generateKeyPair('EdDSA', { extractable: true })
  privateKey = pair.privateKey
  publicPem = await exportSPKI(pair.publicKey)
})

describe('Migrate grant status and install-url routes', () => {
  let db: Record<string, ReturnType<typeof vi.fn>>
  let body: unknown
  const taken = new Set<string>()
  const config = { migrate: { claimPublicKey: '', installStateKey: stateKey }, public: { githubAppSlug: 'contentrain-studio' } }

  const call = async (route: 'status' | 'install-url') => {
    const handler = (route === 'status'
      ? (await import('../../server/api/migrate/grants/status.post')).default
      : (await import('../../server/api/migrate/grants/install-url.post')).default) as (e: unknown) => Promise<unknown>
    return handler({})
  }
  const status = async (over?: Record<string, unknown>) => {
    body = { token: await sign(over) }
  }

  beforeEach(() => {
    vi.resetModules()
    taken.clear()
    config.migrate.claimPublicKey = publicPem
    config.migrate.installStateKey = stateKey
    db = {
      getMigrateGrantByOrderId: vi.fn().mockResolvedValue(grant()),
      getWorkspaceById: vi.fn().mockResolvedValue({ id: 'ws-1', slug: 'acme', type: 'secondary', plan: 'pro', overage_settings: {}, github_installation_id: null }),
      getActivePaymentAccount: vi.fn().mockResolvedValue(null),
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
    vi.stubGlobal('errorMessage', (key: string) => key)
  })

  describe('status', () => {
    it('answers the state, and installed only once redeemed', async () => {
      await status()
      expect(await call('status')).toMatchObject({ state: 'redeemed', installed: false })

      db.getWorkspaceById.mockResolvedValue({ id: 'ws-1', slug: 'acme', github_installation_id: 4242 })
      await status()
      expect(await call('status')).toMatchObject({ state: 'redeemed', installed: true })
      expect(db.getMigrateGrantByOrderId).toHaveBeenCalledWith('ord_123')
    })

    it.each([
      [{ bound_at: null, redeemed_at: null, workspace_id: null }, 'claimed'],
      [{ redeemed_at: null }, 'bound'],
    ])('reads %o as %s, never installed before the subscription runs', async (over, state) => {
      db.getMigrateGrantByOrderId.mockResolvedValue(grant(over))
      db.getWorkspaceById.mockResolvedValue({ id: 'ws-1', github_installation_id: 4242 })
      await status()
      expect(await call('status')).toMatchObject({ state, installed: false })
    })

    it('reads a withdrawn grant as revoked and keeps the installed fact', async () => {
      db.getMigrateGrantByOrderId.mockResolvedValue(grant({ revoked_at: '2026-10-03T11:00:00Z', revoked_reason: 'ops' }))
      db.getWorkspaceById.mockResolvedValue({ id: 'ws-1', github_installation_id: 4242 })
      await status()
      expect(await call('status')).toMatchObject({ state: 'revoked', installed: true })
      await status()
      await expect(call('install-url')).rejects.toMatchObject({ statusCode: 409, message: 'migrate.grant_not_ready' })
    })

    describe('what kind of Studio the order has', () => {
      const account = (over: Record<string, unknown> = {}) => ({
        subscription_id: 'sub_1', subscription_status: 'active', plan: 'pro', current_period_end: '2027-01-01T00:00:00Z',
        trial_ends_at: null, cancel_at_period_end: false, grace_period_ends_at: null, plugin_metadata: {}, ...over,
      })
      const bundle = (over: Record<string, unknown> = {}) => grant({ kind: 'bundle', trial_days: null, ...over })

      it('trial: the included days, and when the trial ends', async () => {
        db.getActivePaymentAccount.mockResolvedValue(account({ subscription_status: 'trialing', trial_ends_at: '2026-12-02T00:00:00Z' }))
        await status()
        expect(await call('status')).toMatchObject({ kind: 'trial', plan: 'pro', trial_days: 60, ends_at: Date.parse('2026-12-02T00:00:00Z') / 1000 })
      })

      it('covered: a bundle grant redeemed with no subscription of its own; plan running', async () => {
        db.getMigrateGrantByOrderId.mockResolvedValue(bundle())
        db.getActivePaymentAccount.mockResolvedValue(account())
        await status()
        const answer = await call('status') as Record<string, unknown>
        expect(answer).toMatchObject({ state: 'redeemed', kind: 'covered', plan: 'pro', ends_at: Date.parse('2027-01-01T00:00:00Z') / 1000 })
        expect(answer).not.toHaveProperty('ended')
        expect(answer).not.toHaveProperty('trial_days')
      })

      it('bundle: Studio paid with the order (a subscription of its own)', async () => {
        db.getMigrateGrantByOrderId.mockResolvedValue(bundle({ redeemed_subscription_id: 'sub_1' }))
        db.getActivePaymentAccount.mockResolvedValue(account())
        await status()
        expect(await call('status')).toMatchObject({ kind: 'bundle' })
      })

      it('plan ended: says so, with Studio\'s own text for Migrate to show as is', async () => {
        db.getMigrateGrantByOrderId.mockResolvedValue(bundle())
        db.getActivePaymentAccount.mockResolvedValue(account({ subscription_status: 'canceled' }))
        await status()
        expect(await call('status')).toMatchObject({ kind: 'covered', ended: true, notice: 'migrate.bundle_plan_ended_notice' })
      })
    })

    it('is a 404 for an order Studio holds no grant for', async () => {
      db.getMigrateGrantByOrderId.mockResolvedValue(null)
      await status()
      await expect(call('status')).rejects.toMatchObject({ statusCode: 404 })
    })

    it('refuses an unsigned, foreign-signed or replayed request, and is off without Migrate\'s key', async () => {
      body = { token: 'x.y.z' }
      await expect(call('status')).rejects.toMatchObject({ statusCode: 400 })
      body = { token: await sign({}, (await generateKeyPair('EdDSA')).privateKey) }
      await expect(call('status')).rejects.toMatchObject({ statusCode: 400 })
      body = { token: await sign({ order_id: '' }) }
      await expect(call('status')).rejects.toMatchObject({ statusCode: 400 })

      await status()
      await call('status')
      await expect(call('status')).rejects.toMatchObject({ statusCode: 409 })

      config.migrate.claimPublicKey = ''
      await status()
      await expect(call('status')).rejects.toMatchObject({ statusCode: 404 })
    })

    it('does not spend a status token on the install-url route (purposes are separate)', async () => {
      await status()
      await call('status')
      expect([...taken]).toEqual([expect.stringMatching(/^grant-status:/)])
    })
  })

  describe('install-url', () => {
    it('hands out GitHub\'s install page with a signed state naming the grant, workspace and owner', async () => {
      await status()
      const out = await call('install-url') as { url: string, expires_at: number }
      const url = new URL(out.url)
      expect(`${url.origin}${url.pathname}`).toBe('https://github.com/apps/contentrain-studio/installations/new')
      const state = await verifyMigrateInstallState(url.searchParams.get('state')!, new TextEncoder().encode(stateKey))
      expect(state).toMatchObject({ grantId: 'grant-1', workspaceId: 'ws-1', userId: 'user-1', exp: out.expires_at })
      expect(out.url).not.toMatch(/repo/i)
    })

    it('waits for a running subscription and for a workspace', async () => {
      db.getMigrateGrantByOrderId.mockResolvedValue(grant({ redeemed_at: null }))
      await status()
      await expect(call('install-url')).rejects.toMatchObject({ statusCode: 409, message: 'migrate.grant_not_ready' })
      db.getMigrateGrantByOrderId.mockResolvedValue(grant({ workspace_id: null }))
      await status()
      await expect(call('install-url')).rejects.toMatchObject({ statusCode: 409, message: 'migrate.grant_not_ready' })
    })

    it('refuses when the App is already installed, for an unknown order, and when its own key is not set', async () => {
      db.getWorkspaceById.mockResolvedValue({ id: 'ws-1', github_installation_id: 4242 })
      await status()
      await expect(call('install-url')).rejects.toMatchObject({ statusCode: 409, message: 'migrate.install_already' })

      db.getMigrateGrantByOrderId.mockResolvedValue(null)
      await status()
      await expect(call('install-url')).rejects.toMatchObject({ statusCode: 404, message: 'migrate.grant_not_found' })

      config.migrate.installStateKey = ''
      await status()
      await expect(call('install-url')).rejects.toMatchObject({ statusCode: 404, message: 'migrate.unavailable' })
    })

    it('takes each request token once', async () => {
      await status()
      await call('install-url')
      await expect(call('install-url')).rejects.toMatchObject({ statusCode: 409 })
    })
  })
})

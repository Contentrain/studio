import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { hashCDNKey } from '../../server/utils/cdn-keys'

async function loadCacheModule() {
  return import('../../server/utils/cdn-delivery-cache')
}

const KEY = 'crn_live_unit-test-key'
const AUTH = `Bearer ${KEY}`

function validKeyRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'key-1',
    project_id: 'project-1',
    rate_limit_per_hour: 100,
    allowed_origins: [],
    scopes: ['delivery'],
    expires_at: null,
    ...overrides,
  }
}

describe('cdn delivery cache', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.stubGlobal('createError', ({ statusCode, message }: { statusCode: number, message: string }) =>
      Object.assign(new Error(message), { statusCode, message }),
    )
    vi.stubGlobal('hashCDNKey', hashCDNKey)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('caches a positive key validation for the TTL window', async () => {
    const validateCDNKeyHash = vi.fn().mockResolvedValue(validKeyRow())
    const updateCDNKeyLastUsed = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('useDatabaseProvider', vi.fn().mockReturnValue({ validateCDNKeyHash, updateCDNKeyLastUsed }))

    const { cachedValidateCDNKey } = await loadCacheModule()

    const first = await cachedValidateCDNKey(AUTH)
    const second = await cachedValidateCDNKey(AUTH)

    expect(first.keyId).toBe('key-1')
    expect(second).toEqual(first)
    expect(validateCDNKeyHash).toHaveBeenCalledOnce()
  })

  it('never caches an invalid key', async () => {
    const validateCDNKeyHash = vi.fn().mockResolvedValue(null)
    vi.stubGlobal('useDatabaseProvider', vi.fn().mockReturnValue({ validateCDNKeyHash }))

    const { cachedValidateCDNKey } = await loadCacheModule()

    await expect(cachedValidateCDNKey(AUTH)).rejects.toMatchObject({ statusCode: 401 })
    await expect(cachedValidateCDNKey(AUTH)).rejects.toMatchObject({ statusCode: 401 })
    expect(validateCDNKeyHash).toHaveBeenCalledTimes(2)
  })

  it('rejects a malformed bearer token before touching the database', async () => {
    const validateCDNKeyHash = vi.fn()
    vi.stubGlobal('useDatabaseProvider', vi.fn().mockReturnValue({ validateCDNKeyHash }))

    const { cachedValidateCDNKey } = await loadCacheModule()

    await expect(cachedValidateCDNKey(undefined)).rejects.toMatchObject({ statusCode: 401 })
    await expect(cachedValidateCDNKey('Bearer other_scheme')).rejects.toMatchObject({ statusCode: 401 })
    expect(validateCDNKeyHash).not.toHaveBeenCalled()
  })

  it('expires cached entries after the TTL', async () => {
    vi.useFakeTimers()
    const validateCDNKeyHash = vi.fn().mockResolvedValue(validKeyRow())
    const updateCDNKeyLastUsed = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('useDatabaseProvider', vi.fn().mockReturnValue({ validateCDNKeyHash, updateCDNKeyLastUsed }))

    const { cachedValidateCDNKey } = await loadCacheModule()

    await cachedValidateCDNKey(AUTH)
    vi.advanceTimersByTime(61_000)
    await cachedValidateCDNKey(AUTH)

    expect(validateCDNKeyHash).toHaveBeenCalledTimes(2)
  })

  it('re-checks expires_at on every cache hit', async () => {
    vi.useFakeTimers()
    const expiresAt = new Date(Date.now() + 10_000).toISOString()
    const validateCDNKeyHash = vi.fn().mockResolvedValue(validKeyRow({ expires_at: expiresAt }))
    const updateCDNKeyLastUsed = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('useDatabaseProvider', vi.fn().mockReturnValue({ validateCDNKeyHash, updateCDNKeyLastUsed }))

    const { cachedValidateCDNKey } = await loadCacheModule()

    await cachedValidateCDNKey(AUTH) // fill (valid now)
    vi.advanceTimersByTime(20_000) // still within TTL, but past expires_at

    await expect(cachedValidateCDNKey(AUTH)).rejects.toMatchObject({
      statusCode: 401,
      message: 'cdn.key_expired',
    })
  })

  it('bustCDNKeyCache drops the entry immediately (revoke path)', async () => {
    const validateCDNKeyHash = vi.fn().mockResolvedValue(validKeyRow())
    const updateCDNKeyLastUsed = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('useDatabaseProvider', vi.fn().mockReturnValue({ validateCDNKeyHash, updateCDNKeyLastUsed }))

    const { cachedValidateCDNKey, bustCDNKeyCache } = await loadCacheModule()

    await cachedValidateCDNKey(AUTH)
    bustCDNKeyCache('key-1')

    // Revoked in DB now — the next request must observe it.
    validateCDNKeyHash.mockResolvedValue(null)
    await expect(cachedValidateCDNKey(AUTH)).rejects.toMatchObject({ statusCode: 401 })
    expect(validateCDNKeyHash).toHaveBeenCalledTimes(2)
  })

  it('throttles last_used_at updates to one per cache fill', async () => {
    const validateCDNKeyHash = vi.fn().mockResolvedValue(validKeyRow())
    const updateCDNKeyLastUsed = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('useDatabaseProvider', vi.fn().mockReturnValue({ validateCDNKeyHash, updateCDNKeyLastUsed }))

    const { cachedValidateCDNKey } = await loadCacheModule()

    await cachedValidateCDNKey(AUTH)
    await cachedValidateCDNKey(AUTH)
    await cachedValidateCDNKey(AUTH)

    expect(updateCDNKeyLastUsed).toHaveBeenCalledOnce()
  })

  it('caches project delivery flags and busts on demand', async () => {
    const getProjectById = vi.fn().mockResolvedValue({ workspace_id: 'ws-1', cdn_enabled: true, cdn_public_media: false })
    vi.stubGlobal('useDatabaseProvider', vi.fn().mockReturnValue({ getProjectById }))

    const { cachedProjectDelivery, bustProjectDeliveryCache } = await loadCacheModule()

    await cachedProjectDelivery('project-1')
    await cachedProjectDelivery('project-1')
    expect(getProjectById).toHaveBeenCalledOnce()

    bustProjectDeliveryCache('project-1')
    await cachedProjectDelivery('project-1')
    expect(getProjectById).toHaveBeenCalledTimes(2)
  })

  it('does not cache a missing project', async () => {
    const getProjectById = vi.fn().mockResolvedValue(null)
    vi.stubGlobal('useDatabaseProvider', vi.fn().mockReturnValue({ getProjectById }))

    const { cachedProjectDelivery } = await loadCacheModule()

    expect(await cachedProjectDelivery('ghost')).toBeNull()
    expect(await cachedProjectDelivery('ghost')).toBeNull()
    expect(getProjectById).toHaveBeenCalledTimes(2)
  })

  it('caches the workspace plan row', async () => {
    const getWorkspaceById = vi.fn().mockResolvedValue({ plan: 'pro' })
    vi.stubGlobal('useDatabaseProvider', vi.fn().mockReturnValue({ getWorkspaceById }))

    const { cachedWorkspacePlan } = await loadCacheModule()

    expect(await cachedWorkspacePlan('ws-1')).toEqual({ plan: 'pro' })
    expect(await cachedWorkspacePlan('ws-1')).toEqual({ plan: 'pro' })
    expect(getWorkspaceById).toHaveBeenCalledOnce()
  })
})

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  _resetDeployDebounce,
  encodeDeployTarget,
  hookHint,
  readStoredDeployTarget,
  toPublicDeployTarget,
  triggerProjectDeploy,
} from '../../server/utils/deploy-hooks'
import { decryptApiKey } from '../../server/utils/encryption'

const SECRET = 'test-session-secret-32-characters-min'

describe('deploy target codec', () => {
  beforeEach(() => {
    vi.stubGlobal('useRuntimeConfig', () => ({ sessionSecret: SECRET, sessionSecretPrevious: '' }))
    vi.stubGlobal('errorMessage', (key: string) => key)
    vi.stubGlobal('createError', (input: { statusCode: number, message: string }) => Object.assign(new Error(input.message), { statusCode: input.statusCode }))
  })

  it('encrypts the hook URL, keeps only a hint public, and round-trips through the stored shape', () => {
    const stored = encodeDeployTarget({ provider: 'netlify', hookUrl: 'https://api.netlify.com/build_hooks/abcd1234efgh' })
    expect(stored.hook_url_encrypted).not.toContain('build_hooks')
    expect(decryptApiKey(stored.hook_url_encrypted, SECRET)).toBe('https://api.netlify.com/build_hooks/abcd1234efgh')
    expect(stored.hook_hint).toBe('api.netlify.com/…efgh')
    expect(stored.triggers).toEqual({ on_publish: true, on_schedule: true })

    const pub = toPublicDeployTarget(stored)
    expect(JSON.stringify(pub)).not.toContain('abcd1234')
    expect(pub.hookHint).toBe(stored.hook_hint)

    expect(readStoredDeployTarget(JSON.parse(JSON.stringify(stored)))).toEqual(stored)
    expect(readStoredDeployTarget({ provider: 'nope', hook_url_encrypted: 'x' })).toBeNull()
    expect(readStoredDeployTarget(null)).toBeNull()
  })

  it('refuses http, private and malformed hook URLs', () => {
    expect(() => encodeDeployTarget({ provider: 'generic', hookUrl: 'http://example.com/hook' })).toThrow('deploy.hook_url_invalid')
    expect(() => encodeDeployTarget({ provider: 'generic', hookUrl: 'https://10.0.0.1/hook' })).toThrow('deploy.hook_url_invalid')
    expect(() => encodeDeployTarget({ provider: 'generic', hookUrl: 'not a url' })).toThrow('deploy.hook_url_invalid')
  })

  it('keeps previous trigger switches and last-trigger stamps when only the URL changes', () => {
    const previous = { ...encodeDeployTarget({ provider: 'vercel', hookUrl: 'https://api.vercel.com/v1/integrations/deploy/prj/abc', triggers: { on_publish: false } }), last_status: 201, last_triggered_at: '2026-01-01T00:00:00.000Z' }
    const next = encodeDeployTarget({ provider: 'vercel', hookUrl: 'https://api.vercel.com/v1/integrations/deploy/prj/def' }, previous)
    expect(next.triggers.on_publish).toBe(false)
    expect(next.last_status).toBe(201)
  })

  it('hints unparsable values without throwing', () => {
    expect(hookHint('nope')).toBe('…')
  })
})

describe('triggerProjectDeploy', () => {
  const setProjectDeployTarget = vi.fn().mockResolvedValue(undefined)
  const emitWebhookEvent = vi.fn().mockResolvedValue(undefined)
  let stored: ReturnType<typeof encodeDeployTarget>

  beforeEach(() => {
    vi.useFakeTimers()
    _resetDeployDebounce()
    vi.stubGlobal('useRuntimeConfig', () => ({ sessionSecret: SECRET, sessionSecretPrevious: '' }))
    vi.stubGlobal('errorMessage', (key: string) => key)
    vi.stubGlobal('createError', (input: { statusCode: number, message: string }) => Object.assign(new Error(input.message), { statusCode: input.statusCode }))
    vi.stubGlobal('emitWebhookEvent', emitWebhookEvent)
    stored = encodeDeployTarget({ provider: 'netlify', hookUrl: 'https://api.netlify.com/build_hooks/abcd1234efgh', triggers: { on_schedule: false } })
    vi.stubGlobal('useDatabaseProvider', () => ({
      getProjectById: vi.fn().mockResolvedValue({ id: 'p-1', workspace_id: 'ws-1', deploy_target: stored }),
      setProjectDeployTarget,
    }))
    setProjectDeployTarget.mockClear()
    emitWebhookEvent.mockClear()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('posts the decrypted hook with the reason, stamps the target, and announces deploy.triggered', async () => {
    const provider = { key: 'test', triggerDeploy: vi.fn().mockResolvedValue({ ok: true, status: 200 }) }
    const result = await triggerProjectDeploy({ projectId: 'p-1', reason: 'manual', immediate: true, provider })
    expect(result).toEqual({ ok: true, status: 200 })
    expect(provider.triggerDeploy).toHaveBeenCalledWith({ provider: 'netlify', hookUrl: 'https://api.netlify.com/build_hooks/abcd1234efgh' }, 'manual')
    expect(setProjectDeployTarget).toHaveBeenCalledWith('p-1', expect.objectContaining({ last_status: 200, hook_url_encrypted: stored.hook_url_encrypted }))
    expect(emitWebhookEvent).toHaveBeenCalledWith('p-1', 'ws-1', 'deploy.triggered', expect.objectContaining({ reason: 'manual', ok: true, status: 200 }))
  })

  it('honours the trigger switches', async () => {
    const provider = { key: 'test', triggerDeploy: vi.fn().mockResolvedValue({ ok: true, status: 200 }) }
    expect(await triggerProjectDeploy({ projectId: 'p-1', reason: 'schedule', immediate: true, provider })).toBeNull()
    expect(provider.triggerDeploy).not.toHaveBeenCalled()
  })

  it('debounces a burst of publishes into one leading and one trailing call', async () => {
    const provider = { key: 'test', triggerDeploy: vi.fn().mockResolvedValue({ ok: true, status: 200 }) }
    await triggerProjectDeploy({ projectId: 'p-1', reason: 'content_published', provider })
    await triggerProjectDeploy({ projectId: 'p-1', reason: 'content_published', provider })
    await triggerProjectDeploy({ projectId: 'p-1', reason: 'content_published', provider })
    expect(provider.triggerDeploy).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(61_000)
    expect(provider.triggerDeploy).toHaveBeenCalledTimes(2)
  })

  it('returns null when the project has no target', async () => {
    vi.stubGlobal('useDatabaseProvider', () => ({ getProjectById: vi.fn().mockResolvedValue({ id: 'p-1', deploy_target: null }), setProjectDeployTarget }))
    expect(await triggerProjectDeploy({ projectId: 'p-1', reason: 'manual', immediate: true })).toBeNull()
  })
})

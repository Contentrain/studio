import { beforeEach, describe, expect, it, vi } from 'vitest'
// vi.mock is hoisted above this import, so the store is already mocked.
import { isCimdClientId, resolveCimdClient } from '../../server/utils/oauth-server/cimd'

const CLIENT_URL = 'https://claude.ai/oauth/claude-code-client-metadata'

const state = vi.hoisted(() => ({
  cached: null as Record<string, unknown> | null,
  upserted: [] as Array<Record<string, unknown>>,
}))

vi.mock('../../server/utils/oauth-server/store', () => ({
  getClient: vi.fn(async () => state.cached),
  upsertCimdClient: vi.fn(async (input: Record<string, unknown>) => {
    state.upserted.push(input)
    return {
      clientId: input.clientId,
      kind: 'cimd',
      clientName: input.clientName ?? null,
      clientUri: input.clientUri ?? null,
      logoUri: input.logoUri ?? null,
      redirectUris: input.redirectUris,
      metadata: input.raw,
      metadataFetchedAt: new Date().toISOString(),
    }
  }),
  isCimdCacheFresh: (ts: string | null) => !!ts && Date.now() - Date.parse(ts) < 3600_000,
}))

function fetchReturning(doc: unknown, init: { status?: number } = {}) {
  return vi.fn(async () => new Response(JSON.stringify(doc), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json' },
  }))
}

function validDoc(overrides: Record<string, unknown> = {}) {
  return {
    client_id: CLIENT_URL,
    client_name: 'Claude Code',
    redirect_uris: ['http://localhost/callback', 'http://127.0.0.1/callback'],
    token_endpoint_auth_method: 'none',
    ...overrides,
  }
}

describe('CIMD client resolution', () => {
  beforeEach(() => {
    state.cached = null
    state.upserted = []
    vi.unstubAllGlobals()
  })

  it('recognizes https URLs as CIMD client ids', () => {
    expect(isCimdClientId(CLIENT_URL)).toBe(true)
    expect(isCimdClientId('dcr_abc123')).toBe(false)
  })

  it('fetches, validates and caches a valid document', async () => {
    vi.stubGlobal('fetch', fetchReturning(validDoc()))

    const result = await resolveCimdClient(CLIENT_URL)
    expect(result.ok).toBe(true)
    expect(state.upserted).toHaveLength(1)
    expect(state.upserted[0]!.clientId).toBe(CLIENT_URL)
  })

  it('rejects a document that is not self-referential', async () => {
    vi.stubGlobal('fetch', fetchReturning(validDoc({ client_id: 'https://claude.ai/other.json' })))

    const result = await resolveCimdClient(CLIENT_URL)
    expect(result).toEqual({ ok: false, error: expect.stringContaining('self-referential') })
  })

  it('rejects SSRF-prone client_id URLs without fetching', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)

    for (const url of [
      'http://claude.ai/client.json', // not https
      'https://192.168.1.1/client.json', // IP literal
      'https://[::1]/client.json', // IPv6 loopback
      'https://localhost/client.json',
      'https://intranet/client.json', // dotless internal hostname
      'https://claude.ai:8443/client.json', // port override
      'https://user:pw@claude.ai/client.json', // credentials
      'https://claude.ai/', // no path component
    ]) {
      const result = await resolveCimdClient(url)
      expect(result.ok, url).toBe(false)
    }
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('rejects non-loopback redirect_uris outside the client_id registrable domain', async () => {
    vi.stubGlobal('fetch', fetchReturning(validDoc({
      redirect_uris: ['https://evil.example/callback'],
    })))

    const result = await resolveCimdClient(CLIENT_URL)
    expect(result).toEqual({ ok: false, error: expect.stringContaining('same-site') })
  })

  it('accepts same-domain redirect_uris alongside loopbacks', async () => {
    vi.stubGlobal('fetch', fetchReturning(validDoc({
      redirect_uris: ['https://claude.ai/api/mcp/auth_callback', 'http://localhost/callback'],
    })))

    const result = await resolveCimdClient(CLIENT_URL)
    expect(result.ok).toBe(true)
  })

  it('serves a fresh cache without refetching', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    state.cached = {
      clientId: CLIENT_URL,
      kind: 'cimd',
      clientName: 'Claude Code',
      clientUri: null,
      logoUri: null,
      redirectUris: ['http://localhost/callback'],
      metadata: {},
      metadataFetchedAt: new Date().toISOString(),
    }

    const result = await resolveCimdClient(CLIENT_URL)
    expect(result.ok).toBe(true)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('falls back to a stale cache when the refetch fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('network down')
    }))
    state.cached = {
      clientId: CLIENT_URL,
      kind: 'cimd',
      clientName: 'Claude Code',
      clientUri: null,
      logoUri: null,
      redirectUris: ['http://localhost/callback'],
      metadata: {},
      metadataFetchedAt: new Date(Date.now() - 2 * 3600_000).toISOString(), // stale
    }

    const result = await resolveCimdClient(CLIENT_URL)
    expect(result.ok).toBe(true)
  })

  it('propagates fetch failures when nothing is cached', async () => {
    vi.stubGlobal('fetch', fetchReturning({}, { status: 404 }))

    const result = await resolveCimdClient(CLIENT_URL)
    expect(result).toEqual({ ok: false, error: expect.stringContaining('404') })
  })
})

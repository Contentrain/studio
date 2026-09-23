import { beforeEach, describe, expect, it, vi } from 'vitest'

// `getHeader` is h3's; the event is a plain header bag here.
vi.mock('h3', async () => {
  const actual = await vi.importActual<typeof import('h3')>('h3')
  return { ...actual, getHeader: (event: { headers: Record<string, string> }, name: string) => event.headers[name.toLowerCase()] }
})

const SECRET = 'edge-secret-0123456789'
const event = (headers: Record<string, string>) => ({ headers }) as never

describe('client IP behind the Cloudflare CDN host', { timeout: 30_000 }, () => {
  beforeEach(() => {
    vi.resetModules()
    vi.stubGlobal('getHeader', (e: { headers: Record<string, string> }, name: string) => e.headers[name.toLowerCase()])
    vi.stubGlobal('useRuntimeConfig', () => ({ cdn: { edgeSecret: SECRET }, public: {} }))
  })

  it('uses CF-Connecting-IP only on a request carrying the edge secret', async () => {
    const { getClientIp } = await import('../../server/utils/form-types')
    const viaEdge = { 'x-cr-edge': SECRET, 'cf-connecting-ip': '198.51.100.7', 'x-forwarded-for': '198.51.100.7, 172.70.1.1' }
    expect(getClientIp(event(viaEdge))).toBe('198.51.100.7')
  })

  it('ignores CF-Connecting-IP with a wrong or missing secret — a client cannot pick its IP', async () => {
    const { getClientIp } = await import('../../server/utils/form-types')
    const forged = { 'x-cr-edge': 'guess', 'cf-connecting-ip': '1.2.3.4', 'x-forwarded-for': '1.2.3.4, 203.0.113.5' }
    expect(getClientIp(event(forged))).toBe('203.0.113.5')
    expect(getClientIp(event({ 'cf-connecting-ip': '1.2.3.4', 'x-forwarded-for': '203.0.113.5' }))).toBe('203.0.113.5')
  })

  it('trusts nothing when no secret is configured', async () => {
    vi.stubGlobal('useRuntimeConfig', () => ({ cdn: { edgeSecret: '' }, public: {} }))
    const { getClientIp, isTrustedEdgeRequest } = await import('../../server/utils/form-types')
    const e = event({ 'x-cr-edge': '', 'cf-connecting-ip': '1.2.3.4', 'x-forwarded-for': '203.0.113.5' })
    expect(isTrustedEdgeRequest(e)).toBe(false)
    expect(getClientIp(e)).toBe('203.0.113.5')
  })
})

describe('media URLs with a separate CDN host', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.stubGlobal('useRuntimeConfig', () => ({ public: { siteUrl: 'https://studio.example.com', cdnUrl: 'https://cdn.example.com/' } }))
  })

  it('writes new media URLs under the CDN host', async () => {
    const { toDeliveryUrl } = await import('../../server/utils/media-url')
    expect(toDeliveryUrl('p1', 'media/a.webp')).toBe('https://cdn.example.com/api/cdn/v1/p1/media/a.webp')
  })

  it('still recognises media URLs written on the app host as this project\'s', async () => {
    const { ownMediaStoragePath } = await import('../../server/utils/media-url')
    expect(ownMediaStoragePath('p1', 'https://cdn.example.com/api/cdn/v1/p1/media/a.webp')).toBe('media/a.webp')
    expect(ownMediaStoragePath('p1', 'https://studio.example.com/api/cdn/v1/p1/media/b.webp?w=2')).toBe('media/b.webp')
    expect(ownMediaStoragePath('p1', 'https://other.example.com/api/cdn/v1/p1/media/c.webp')).toBeNull()
  })
})

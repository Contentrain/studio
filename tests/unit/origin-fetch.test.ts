import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { fetchFromOrigin, ipv6Groups, isBlockedAddress, isOnOrigin, OriginFetchError } from '../../server/utils/origin-fetch'

/**
 * A migration's media still at the old site: fetched from that site only,
 * never from an internal address, never through a redirect elsewhere, never
 * past the size cap.
 */

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex')
let server: Server
let port: number

beforeAll(async () => {
  server = createServer((req, res) => {
    const path = req.url ?? '/'
    if (path === '/img.png') return res.writeHead(200, { 'content-type': 'image/png' }).end(PNG)
    if (path === '/moved.png') return res.writeHead(301, { location: '/img.png' }).end()
    if (path === '/away.png') return res.writeHead(302, { location: 'http://elsewhere.test/img.png' }).end()
    if (path === '/loop.png') return res.writeHead(302, { location: '/loop.png' }).end()
    if (path === '/page') return res.writeHead(200, { 'content-type': 'text/html' }).end('<html></html>')
    if (path === '/big-declared') return res.writeHead(200, { 'content-type': 'image/png', 'content-length': '5000' }).end(Buffer.alloc(5000))
    if (path === '/big-streamed') {
      res.writeHead(200, { 'content-type': 'image/png' })
      res.write(Buffer.alloc(600))
      return setTimeout(() => res.end(Buffer.alloc(600)), 5)
    }
    if (path === '/slow') return setTimeout(() => res.writeHead(200, { 'content-type': 'image/png' }).end(PNG), 2000)
    if (path === '/busy') return res.writeHead(503).end()
    if (path === '/gone') return res.writeHead(404).end()
    res.writeHead(500).end()
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  port = (server.address() as AddressInfo).port
})
afterAll(() => new Promise<void>(resolve => server.close(() => resolve())))

const ORIGIN = () => `http://origin.test:${port}`
/** The test server lives on loopback: only this test lets `origin.test` resolve there and be reached. */
const local = (maxBytes = 1024, extra: Record<string, unknown> = {}) => ({
  maxBytes,
  resolve: async () => [{ address: '127.0.0.1', family: 4 }],
  isBlocked: (a: string) => a !== '127.0.0.1',
  ...extra,
})
const fails = async (p: Promise<unknown>) => {
  const error = await p.then(() => null, (e: unknown) => e)
  expect(error).toBeInstanceOf(OriginFetchError)
  return error as OriginFetchError
}

describe('isBlockedAddress', () => {
  it('refuses loopback, private, link-local (metadata), CGNAT, reserved and multicast IPv4', () => {
    for (const a of ['127.0.0.1', '10.1.2.3', '172.16.5.4', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '255.255.255.255', '192.88.99.1', '198.18.0.1'])
      expect(isBlockedAddress(a), a).toBe(true)
    for (const a of ['93.184.216.34', '1.1.1.1', '8.8.8.8'])
      expect(isBlockedAddress(a), a).toBe(false)
  })

  it('judges an IPv6 address that carries an IPv4 one by that IPv4 address — dotted or hex, mapped, compatible, NAT64, 6to4', () => {
    for (const a of [
      '::ffff:127.0.0.1', '::ffff:7f00:1', '::FFFF:7F00:0001', '0:0:0:0:0:ffff:7f00:1', '::ffff:a9fe:a9fe', '::ffff:169.254.169.254', '::ffff:a00:1', '::ffff:c0a8:101',
      '::7f00:1', '::127.0.0.1', '::a9fe:a9fe', // IPv4-compatible (deprecated): refused whatever it carries
      '64:ff9b::7f00:1', '64:ff9b::127.0.0.1', '64:ff9b::a9fe:a9fe', // NAT64
      '2002:7f00:1::', '2002:a9fe:a9fe::1', '2002:c0a8:101::', // 6to4
    ]) expect(isBlockedAddress(a), a).toBe(true)
    for (const a of ['::ffff:93.184.216.34', '::ffff:5db8:d822', '64:ff9b::5db8:d822', '2002:5db8:d822::1'])
      expect(isBlockedAddress(a), a).toBe(false)
  })

  it('lets only global unicast IPv6 through', () => {
    for (const a of ['::', '::1', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'fe80::1%en0', 'ff02::1', '100::1', '64:ff9b:1::1',
      '2001::1', '2001:0:4136:e378::1', '2001:db8::1', '3fff::1', '3fff:fff:ffff::1', 'not-an-ip', ''])
      expect(isBlockedAddress(a), a).toBe(true)
    for (const a of ['2606:4700:4700::1111', '2a00:1450:4001:80b::200e', '2001:4860:4860::8888'])
      expect(isBlockedAddress(a), a).toBe(false)
  })

  it('reads every IPv6 spelling into its eight groups', () => {
    expect(ipv6Groups('::ffff:127.0.0.1')).toEqual([0, 0, 0, 0, 0, 0xFFFF, 0x7F00, 1])
    expect(ipv6Groups('::ffff:7f00:1')).toEqual([0, 0, 0, 0, 0, 0xFFFF, 0x7F00, 1])
    expect(ipv6Groups('2001:db8::')).toEqual([0x2001, 0xDB8, 0, 0, 0, 0, 0, 0])
    expect(ipv6Groups('1:2:3:4:5:6:7:8')).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
    expect(ipv6Groups('::')).toEqual([0, 0, 0, 0, 0, 0, 0, 0])
    expect(ipv6Groups('fe80::1%en0')).toBeNull()
    expect(ipv6Groups('127.0.0.1')).toBeNull()
  })
})

describe('isOnOrigin', () => {
  const origin = new URL('https://blog.example.com')
  it('the origin\'s host on either scheme at its default port; nothing else', () => {
    expect(isOnOrigin(new URL('https://blog.example.com/wp-content/a.png'), origin)).toBe(true)
    expect(isOnOrigin(new URL('http://BLOG.example.com./a.png'), origin)).toBe(true)
    for (const u of ['https://example.com/a.png', 'https://evil.blog.example.com/a.png', 'https://blog.example.com.evil.test/a.png',
      'https://blog.example.com:8443/a.png', 'https://user:pw@blog.example.com/a.png', 'ftp://blog.example.com/a.png', 'file:///etc/passwd'])
      expect(isOnOrigin(new URL(u), origin), u).toBe(false)
    expect(isOnOrigin(new URL('http://127.0.0.1:9410/a.png'), new URL('http://127.0.0.1:9410'))).toBe(true)
  })
})

describe('fetchFromOrigin', () => {
  it('fetches a media file from the origin, following a redirect on the same host', async () => {
    const direct = await fetchFromOrigin(`${ORIGIN()}/img.png`, ORIGIN(), local())
    expect(direct).toMatchObject({ contentType: 'image/png' })
    expect(direct.buffer.equals(PNG)).toBe(true)
    const moved = await fetchFromOrigin(`${ORIGIN()}/moved.png`, ORIGIN(), local())
    expect(moved.url).toBe(`${ORIGIN()}/img.png`)
  })

  it('refuses another host, a redirect to another host, and endless redirects', async () => {
    expect((await fails(fetchFromOrigin(`http://elsewhere.test:${port}/img.png`, ORIGIN(), local()))).code).toBe('off_origin')
    expect((await fails(fetchFromOrigin(`${ORIGIN()}/away.png`, ORIGIN(), local()))).code).toBe('redirect_off_origin')
    expect((await fails(fetchFromOrigin(`${ORIGIN()}/loop.png`, ORIGIN(), local()))).code).toBe('too_many_redirects')
  })

  it('refuses an internal address — resolved (checked at connect) or written as an IP — with the real rule', async () => {
    const resolvedInternal = await fails(fetchFromOrigin(`${ORIGIN()}/img.png`, ORIGIN(), { maxBytes: 1024, resolve: async () => [{ address: '127.0.0.1', family: 4 }] }))
    expect(resolvedInternal).toMatchObject({ code: 'blocked_address', retryable: false })
    const oneBadAnswer = await fails(fetchFromOrigin(`${ORIGIN()}/img.png`, ORIGIN(), { maxBytes: 1024, resolve: async () => [{ address: '93.184.216.34', family: 4 }, { address: '10.0.0.5', family: 4 }] }))
    expect(oneBadAnswer.code).toBe('blocked_address')
    const literal = await fails(fetchFromOrigin(`http://127.0.0.1:${port}/img.png`, `http://127.0.0.1:${port}`, { maxBytes: 1024 }))
    expect(literal.code).toBe('blocked_address')
    const metadata = await fails(fetchFromOrigin('http://169.254.169.254/latest/meta-data', 'http://169.254.169.254', { maxBytes: 1024 }))
    expect(metadata.code).toBe('blocked_address')
    // IPv4 inside an IPv6 literal (WHATWG writes `[::ffff:127.0.0.1]` as `[::ffff:7f00:1]`).
    for (const host of ['[::ffff:127.0.0.1]', '[::ffff:7f00:1]', '[::ffff:a9fe:a9fe]', '[64:ff9b::7f00:1]', '[2002:7f00:1::]', '[::1]']) {
      const origin = `http://${host}:${port}`
      expect((await fails(fetchFromOrigin(`${origin}/img.png`, origin, { maxBytes: 1024 }))).code, host).toBe('blocked_address')
    }
    // …and in a DNS answer.
    const mappedAnswer = await fails(fetchFromOrigin(`${ORIGIN()}/img.png`, ORIGIN(), { maxBytes: 1024, resolve: async () => [{ address: '::ffff:7f00:1', family: 6 }] }))
    expect(mappedAnswer.code).toBe('blocked_address')
  })

  it('refuses a page instead of media, and a file over the cap — declared, or found while streaming', async () => {
    expect((await fails(fetchFromOrigin(`${ORIGIN()}/page`, ORIGIN(), local()))).code).toBe('not_media')
    expect((await fails(fetchFromOrigin(`${ORIGIN()}/big-declared`, ORIGIN(), local(1000)))).code).toBe('too_large')
    expect((await fails(fetchFromOrigin(`${ORIGIN()}/big-streamed`, ORIGIN(), local(1000)))).code).toBe('too_large')
  })

  it('says which failures may pass: a timeout and 5xx are retryable, 404 is not', async () => {
    expect(await fails(fetchFromOrigin(`${ORIGIN()}/slow`, ORIGIN(), local(1024, { deadlineMs: 200 })))).toMatchObject({ code: 'timeout', retryable: true })
    expect(await fails(fetchFromOrigin(`${ORIGIN()}/slow`, ORIGIN(), local(1024, { idleMs: 200 })))).toMatchObject({ code: 'timeout', retryable: true })
    expect(await fails(fetchFromOrigin(`${ORIGIN()}/busy`, ORIGIN(), local()))).toMatchObject({ code: 'bad_status', retryable: true, status: 503 })
    expect(await fails(fetchFromOrigin(`${ORIGIN()}/gone`, ORIGIN(), local()))).toMatchObject({ code: 'bad_status', retryable: false, status: 404 })
  })
})

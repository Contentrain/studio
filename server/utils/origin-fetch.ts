/**
 * Fetch a file from a migrated site's old address — only from that site.
 *
 * Used for a migration's media that Migrate could not commit (over its repo
 * caps) and left at the old WordPress URL. The URL comes from the customer's
 * repository (media.json), so it is untrusted input to a server-side fetch:
 *
 * - only `http:`/`https:` on the manifest origin's host (and its port, or the
 *   protocol's default); nothing else is fetched;
 * - every address the host resolves to is checked when the connection is
 *   made (a custom `lookup`, so the address checked is the address used — a
 *   DNS answer cannot change between the check and the connect; no pooled
 *   socket skips it), and an IP literal is checked before it. Only public
 *   addresses pass (`isBlockedAddress`): public unicast IPv4, global unicast
 *   IPv6, and an IPv6 form that carries an IPv4 address is judged by that
 *   address (mapped, compatible, NAT64, 6to4 — dotted or hex);
 * - redirects are not followed automatically: one to the same host is
 *   followed (at most 3), one to any other host is refused;
 * - the size cap is applied while the body streams (and to a declared
 *   Content-Length before it), never after buffering it all;
 * - an HTML or other non-media response type is refused before its body is
 *   read; the bytes are then checked like any upload by the caller
 *   (`inspectRepoMedia`: sniffed type, allowlist, SVG sanitizer, pixel cap);
 * - a deadline covers the whole fetch, and an idle socket times out sooner.
 *
 * Failures carry `retryable`: a timeout, a dropped connection, 429 or 5xx may
 * pass; anything else will not, and is not retried.
 */

import type { LookupAddress } from 'node:dns'
import { lookup as dnsLookup } from 'node:dns'
import { request as httpRequest } from 'node:http'
import type { IncomingMessage, RequestOptions } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { BlockList, isIP } from 'node:net'

export interface OriginFetchResult {
  buffer: Buffer
  /** The response's declared type (without parameters); the bytes decide the real one. */
  contentType: string
  /** The URL the bytes came from (after same-host redirects). */
  url: string
}

export class OriginFetchError extends Error {
  constructor(
    readonly code: 'bad_url' | 'off_origin' | 'blocked_address' | 'redirect_off_origin' | 'too_many_redirects' | 'bad_status' | 'not_media' | 'too_large' | 'timeout' | 'network',
    readonly retryable: boolean,
    readonly status?: number,
  ) {
    super(`origin fetch: ${code}${status ? ` (${status})` : ''}`)
  }
}

/** IPv4 ranges that are not public unicast: a fetch never reaches them. */
const NOT_PUBLIC_V4 = new BlockList()
for (const [net, prefix] of [
  ['0.0.0.0', 8], // "this network"
  ['10.0.0.0', 8],
  ['100.64.0.0', 10], // CGNAT
  ['127.0.0.0', 8],
  ['169.254.0.0', 16], // link-local, cloud metadata
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24], // 6to4 relay
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved, broadcast
] as const) NOT_PUBLIC_V4.addSubnet(net, prefix, 'ipv4')

/** An IPv6 address as its eight 16-bit groups; null when it is not one (a zone id included). */
export function ipv6Groups(address: string): number[] | null {
  if (isIP(address) !== 6 || address.includes('%')) return null
  let text = address.toLowerCase()
  // A trailing dotted quad (`::ffff:127.0.0.1`) is two groups.
  const quad = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text)
  if (quad) {
    const [a, b, c, d] = quad.slice(1).map(Number) as [number, number, number, number]
    text = `${text.slice(0, quad.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`
  }
  const [head, tail] = text.includes('::') ? text.split('::') as [string, string] : [text, null]
  const left = head ? head.split(':') : []
  const right = tail ? tail.split(':') : []
  const missing = 8 - left.length - right.length
  if (tail === null ? missing !== 0 : missing < 1) return null
  const groups = [...left, ...Array.from({ length: tail === null ? 0 : missing }, () => '0'), ...right].map(g => Number.parseInt(g, 16))
  return groups.length === 8 && groups.every(g => Number.isInteger(g) && g >= 0 && g <= 0xFFFF) ? groups : null
}

const v4Of = (hi: number, lo: number): string => `${hi >> 8}.${hi & 0xFF}.${lo >> 8}.${lo & 0xFF}`

/**
 * True when a fetch must not reach `address`. Allowlist: an IPv4 address must be public unicast; an IPv6 address must be
 * global unicast (2000::/3, less its special blocks). An IPv6 address that carries an IPv4 address — mapped
 * (`::ffff:0:0/96`, dotted or hex), compatible (`::/96`), NAT64 (`64:ff9b::/96`) or 6to4 (`2002::/16`) — is judged
 * by the IPv4 address it carries. Anything unparseable is refused.
 */
export function isBlockedAddress(address: string): boolean {
  const family = isIP(address)
  if (family === 4) return NOT_PUBLIC_V4.check(address, 'ipv4')
  if (family !== 6) return true
  const g = ipv6Groups(address)
  if (!g) return true
  const zeros = (n: number) => g.slice(0, n).every(x => x === 0)
  if (zeros(5) && g[5] === 0xFFFF) return isBlockedAddress(v4Of(g[6]!, g[7]!)) // IPv4-mapped
  if (zeros(6)) return true // ::, ::1 and the deprecated IPv4-compatible block
  if (g[0] === 0x64 && g[1] === 0xFF9B && g.slice(2, 6).every(x => x === 0)) return isBlockedAddress(v4Of(g[6]!, g[7]!)) // NAT64
  if (g[0] === 0x2002) return isBlockedAddress(v4Of(g[1]!, g[2]!)) // 6to4
  if ((g[0]! & 0xE000) !== 0x2000) return true // not global unicast: ULA, link-local, multicast, 64:ff9b:1::/48, …
  if (g[0] === 0x2001 && g[1]! < 0x0200) return true // 2001::/23 — IETF protocol assignments (Teredo, benchmarking, ORCHID)
  if (g[0] === 0x2001 && g[1] === 0x0DB8) return true // documentation
  if ((g[0]! & 0xFFF0) === 0x3FF0) return true // 3fff::/20 — documentation
  return false
}

/** Response types a media file may arrive with. The bytes are sniffed afterwards; this only refuses pages early. */
function isMediaResponseType(type: string): boolean {
  return /^(?:image|video|audio)\/[\w.+-]+$/.test(type) || type === 'application/pdf' || type === 'application/octet-stream' || type === 'binary/octet-stream' || type === ''
}

const defaultPort = (protocol: string): string => (protocol === 'https:' ? '443' : '80')
const hostOf = (host: string): string => host.toLowerCase().replace(/\.$/, '').replace(/^\[|\]$/g, '')

/** Whether `url` is on `origin`'s host and port (either scheme; the port is the scheme's default unless the origin names one). */
export function isOnOrigin(url: URL, origin: URL): boolean {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
  if (url.username || url.password) return false
  if (hostOf(url.hostname) !== hostOf(origin.hostname)) return false
  const port = url.port || defaultPort(url.protocol)
  return origin.port ? port === origin.port : port === defaultPort(url.protocol)
}

export interface OriginFetchOptions {
  maxBytes: number
  /** Whole fetch, redirects included. */
  deadlineMs?: number
  /** A socket with no activity for this long is dropped. */
  idleMs?: number
  /** Test seams: the resolver, and the address rule (never set outside tests). */
  resolve?: (host: string) => Promise<LookupAddress[]>
  isBlocked?: (address: string) => boolean
}

const resolveAll = (host: string): Promise<LookupAddress[]> => new Promise((resolve, reject) => {
  dnsLookup(host, { all: true, verbatim: true }, (error, addresses) => (error ? reject(error) : resolve(addresses)))
})

export async function fetchFromOrigin(rawUrl: string, rawOrigin: string, options: OriginFetchOptions): Promise<OriginFetchResult> {
  let origin: URL
  let url: URL
  try {
    origin = new URL(rawOrigin)
    url = new URL(rawUrl)
  }
  catch {
    throw new OriginFetchError('bad_url', false)
  }
  if (!isOnOrigin(url, origin)) throw new OriginFetchError('off_origin', false)

  const blocked = options.isBlocked ?? isBlockedAddress
  const resolve = options.resolve ?? resolveAll
  const deadline = Date.now() + (options.deadlineMs ?? 60_000)

  for (let hop = 0; hop <= 3; hop++) {
    const response = await get(url, { blocked, resolve, deadline, idleMs: options.idleMs ?? 20_000 })
    const status = response.statusCode ?? 0

    if (status >= 300 && status < 400) {
      response.resume()
      const location = response.headers.location
      if (!location) throw new OriginFetchError('bad_status', false, status)
      let next: URL
      try {
        next = new URL(location, url)
      }
      catch {
        throw new OriginFetchError('bad_url', false)
      }
      if (!isOnOrigin(next, origin)) throw new OriginFetchError('redirect_off_origin', false, status)
      url = next
      continue
    }
    if (status !== 200) {
      response.resume()
      throw new OriginFetchError('bad_status', status === 429 || status >= 500, status)
    }

    const contentType = String(response.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase()
    if (!isMediaResponseType(contentType)) {
      response.destroy()
      throw new OriginFetchError('not_media', false)
    }
    const declared = Number(response.headers['content-length'])
    if (Number.isFinite(declared) && declared > options.maxBytes) {
      response.destroy()
      throw new OriginFetchError('too_large', false)
    }
    return { buffer: await readCapped(response, options.maxBytes, deadline), contentType, url: url.toString() }
  }
  throw new OriginFetchError('too_many_redirects', false)
}

function get(url: URL, ctx: { blocked: (a: string) => boolean, resolve: (h: string) => Promise<LookupAddress[]>, deadline: number, idleMs: number }): Promise<IncomingMessage> {
  const remaining = ctx.deadline - Date.now()
  if (remaining <= 0) return Promise.reject(new OriginFetchError('timeout', true))
  const host = hostOf(url.hostname)
  // An IP literal never goes through `lookup`: judge it here.
  if (isIP(host) && ctx.blocked(host)) return Promise.reject(new OriginFetchError('blocked_address', false))

  const lookup: RequestOptions['lookup'] = (hostname, _opts, callback) => {
    ctx.resolve(hostname).then((addresses) => {
      if (addresses.length === 0 || addresses.some(a => ctx.blocked(a.address)))
        return callback(new OriginFetchError('blocked_address', false), '', 4)
      const first = addresses[0]!
      // Node asks with `all: true` (happy eyeballs) or for one address.
      if ((_opts as { all?: boolean }).all) return (callback as unknown as (e: null, a: LookupAddress[]) => void)(null, addresses)
      callback(null, first.address, first.family)
    }, error => callback(error as NodeJS.ErrnoException, '', 4))
  }

  return new Promise((resolve, reject) => {
    const send = url.protocol === 'https:' ? httpsRequest : httpRequest
    const req = send(url, {
      method: 'GET',
      // A fresh connection every time: a pooled socket would skip `lookup`, and with it the address check.
      agent: false,
      lookup,
      headers: { 'User-Agent': 'Contentrain-Studio/1.0 (migration media)', 'Accept': 'image/*,video/*,audio/*,application/pdf;q=0.9,*/*;q=0.1' },
      timeout: ctx.idleMs,
      signal: AbortSignal.timeout(remaining),
    })
    req.on('response', resolve)
    req.on('timeout', () => req.destroy(new OriginFetchError('timeout', true)))
    req.on('error', (error) => {
      if (error instanceof OriginFetchError) return reject(error)
      if ((error as { name?: string }).name === 'AbortError' || (error as { name?: string }).name === 'TimeoutError') return reject(new OriginFetchError('timeout', true))
      reject(new OriginFetchError('network', true))
    })
    req.end()
  })
}

function readCapped(response: IncomingMessage, maxBytes: number, deadline: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let total = 0
    const timer = setTimeout(() => response.destroy(new OriginFetchError('timeout', true)), Math.max(0, deadline - Date.now()))
    response.on('data', (chunk: Buffer) => {
      total += chunk.length
      if (total > maxBytes) {
        response.destroy(new OriginFetchError('too_large', false))
        return
      }
      chunks.push(chunk)
    })
    response.on('end', () => {
      clearTimeout(timer)
      resolve(Buffer.concat(chunks))
    })
    response.on('error', (error) => {
      clearTimeout(timer)
      reject(error instanceof OriginFetchError ? error : new OriginFetchError('network', true))
    })
    response.on('close', () => {
      clearTimeout(timer)
      if (!response.complete) reject(new OriginFetchError('network', true))
    })
  })
}

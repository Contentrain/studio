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
 *   socket skips it), and an IP literal is checked before it: loopback, private, link-local (cloud
 *   metadata), CGNAT, unique-local, multicast and reserved ranges are refused;
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

/** Addresses a fetch must never reach. */
const BLOCKED = new BlockList()
for (const [net, prefix] of [
  ['0.0.0.0', 8], // "this network"
  ['10.0.0.0', 8],
  ['100.64.0.0', 10], // CGNAT
  ['127.0.0.0', 8],
  ['169.254.0.0', 16], // link-local, cloud metadata
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved, broadcast
] as const) BLOCKED.addSubnet(net, prefix, 'ipv4')
for (const [net, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['64:ff9b::', 96], // NAT64 — embeds an IPv4 address
  ['100::', 64],
  ['2001:db8::', 32],
  ['fc00::', 7], // unique-local
  ['fe80::', 10], // link-local
  ['ff00::', 8], // multicast
] as const) BLOCKED.addSubnet(net, prefix, 'ipv6')

/** True when `address` is one a fetch must not reach. An IPv4-mapped IPv6 address is judged as its IPv4 address. */
export function isBlockedAddress(address: string): boolean {
  const family = isIP(address)
  if (family === 0) return true
  if (family === 6) {
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)
    if (mapped) return isBlockedAddress(mapped[1]!)
    return BLOCKED.check(address, 'ipv6')
  }
  return BLOCKED.check(address, 'ipv4')
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

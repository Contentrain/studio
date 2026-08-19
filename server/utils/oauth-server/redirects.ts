/**
 * Redirect-URI validation for the OAuth AS.
 *
 * Exact string match, with one deliberate exception: loopback redirects are
 * compared with the PORT IGNORED (RFC 8252 §7.3). Native MCP clients bind an
 * ephemeral port at runtime — Claude Code declares `http://localhost/callback`
 * and `http://127.0.0.1/callback` in its CIMD and then redirects to e.g.
 * `http://localhost:53411/callback`; Codex does the same via DCR. Hosts never
 * cross-match (`localhost` ≠ `127.0.0.1`): clients declare every loopback
 * host they use.
 */

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

function parseUri(uri: string): URL | null {
  try {
    return new URL(uri)
  }
  catch {
    return null
  }
}

export function isLoopbackRedirect(uri: string): boolean {
  const parsed = parseUri(uri)
  return parsed !== null && LOOPBACK_HOSTS.has(parsed.hostname === '::1' ? '[::1]' : parsed.hostname)
}

function loopbackHostname(parsed: URL): string {
  // URL#hostname strips brackets for IPv6 in some runtimes — normalize.
  return parsed.hostname === '::1' ? '[::1]' : parsed.hostname
}

export function matchRedirectUri(registered: string[], requested: string): boolean {
  if (registered.includes(requested)) return true

  const req = parseUri(requested)
  if (!req || !LOOPBACK_HOSTS.has(loopbackHostname(req))) return false

  // Port-agnostic loopback match: scheme + host + path must still agree.
  return registered.some((entry) => {
    const reg = parseUri(entry)
    return reg !== null
      && LOOPBACK_HOSTS.has(loopbackHostname(reg))
      && loopbackHostname(reg) === loopbackHostname(req)
      && reg.protocol === req.protocol
      && reg.pathname === req.pathname
  })
}

/**
 * Registration-time validation (DCR bodies and CIMD documents): absolute
 * URIs, no fragments, https everywhere except plain-http loopback.
 * Returns an error string or null.
 */
export function validateRegistrableRedirectUris(uris: unknown): string | null {
  if (!Array.isArray(uris) || uris.length === 0)
    return 'redirect_uris must be a non-empty array'

  for (const uri of uris) {
    if (typeof uri !== 'string') return 'redirect_uris entries must be strings'
    const parsed = parseUri(uri)
    if (!parsed) return `invalid redirect_uri: ${uri}`
    if (parsed.hash) return `redirect_uri must not contain a fragment: ${uri}`
    const loopback = LOOPBACK_HOSTS.has(loopbackHostname(parsed))
    if (parsed.protocol === 'https:') continue
    if (parsed.protocol === 'http:' && loopback) continue
    return `redirect_uri must be https (or http on loopback): ${uri}`
  }

  return null
}

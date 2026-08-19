/**
 * Client ID Metadata Documents (draft-ietf-oauth-client-id-metadata-document).
 *
 * The client_id IS an HTTPS URL pointing at a JSON registration document —
 * no /register round-trip. Claude and ChatGPT both prefer this over DCR.
 * The AS fetches an attacker-suppliable URL, so the guards here are the
 * security boundary:
 *
 * - https only, default port, no credentials/fragment, and a real hostname
 *   (no IP literals, no localhost, must contain a dot). Redirects are NOT
 *   followed. This closes direct internal-endpoint probing; DNS-level
 *   rebinding is accepted residual risk for v1 (the response is never
 *   echoed to the caller — worst case is a garbage client row).
 * - The document MUST be self-referential: its client_id equals the URL it
 *   was fetched from, byte for byte.
 * - Non-loopback redirect_uris must share the client_id URL's registrable
 *   domain (naive eTLD+1 — fine for claude.ai / chatgpt.com; multi-label
 *   public suffixes like co.uk would over-match, acceptable for an allowlist
 *   direction check).
 * - Docs are cached in auth.oauth_clients for 1h so /oauth/authorize doesn't
 *   refetch per dance.
 */
import { isIP } from 'node:net'
import type { OAuthClientRow } from './store'
import { getClient, isCimdCacheFresh, upsertCimdClient } from './store'
import { isLoopbackRedirect, validateRegistrableRedirectUris } from './redirects'

const FETCH_TIMEOUT_MS = 5000
const MAX_DOCUMENT_BYTES = 64 * 1024

export type CimdResult
  = | { ok: true, client: OAuthClientRow }
    | { ok: false, error: string }

export function isCimdClientId(clientId: string): boolean {
  return clientId.startsWith('https://')
}

function validateCimdUrl(clientIdUrl: string): { url: URL } | { error: string } {
  let url: URL
  try {
    url = new URL(clientIdUrl)
  }
  catch {
    return { error: 'client_id is not a valid URL' }
  }

  if (url.protocol !== 'https:') return { error: 'client_id URL must be https' }
  if (url.port !== '') return { error: 'client_id URL must use the default port' }
  if (url.username || url.password) return { error: 'client_id URL must not contain credentials' }
  if (url.hash) return { error: 'client_id URL must not contain a fragment' }
  if (url.pathname === '/' || url.pathname === '') return { error: 'client_id URL must contain a path component' }

  const host = url.hostname.replace(/^\[|\]$/g, '')
  if (isIP(host) !== 0) return { error: 'client_id URL must not be an IP literal' }
  if (host === 'localhost' || !host.includes('.')) return { error: 'client_id URL host is not allowed' }

  return { url }
}

/** Naive registrable-domain comparison (last two labels). */
function sameRegistrableDomain(hostA: string, hostB: string): boolean {
  const tail = (host: string) => host.toLowerCase().split('.').slice(-2).join('.')
  return tail(hostA) === tail(hostB)
}

async function fetchDocument(url: string): Promise<{ doc: Record<string, unknown> } | { error: string }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)

  try {
    const response = await fetch(url, {
      headers: { accept: 'application/json' },
      redirect: 'error',
      signal: controller.signal,
    })
    if (!response.ok) return { error: `client_id URL returned ${response.status}` }

    const body = await response.text()
    if (body.length > MAX_DOCUMENT_BYTES) return { error: 'client metadata document is too large' }

    const doc = JSON.parse(body) as unknown
    if (!doc || typeof doc !== 'object' || Array.isArray(doc))
      return { error: 'client metadata document must be a JSON object' }

    return { doc: doc as Record<string, unknown> }
  }
  catch {
    return { error: 'failed to fetch client metadata document' }
  }
  finally {
    clearTimeout(timer)
  }
}

export async function resolveCimdClient(clientIdUrl: string): Promise<CimdResult> {
  const validated = validateCimdUrl(clientIdUrl)
  if ('error' in validated) return { ok: false, error: validated.error }

  const cached = await getClient(clientIdUrl)
  if (cached?.kind === 'cimd' && isCimdCacheFresh(cached.metadataFetchedAt))
    return { ok: true, client: cached }

  const fetched = await fetchDocument(clientIdUrl)
  if ('error' in fetched) {
    // A stale cache beats a hard failure — the document was valid once.
    if (cached?.kind === 'cimd') return { ok: true, client: cached }
    return { ok: false, error: fetched.error }
  }

  const doc = fetched.doc

  if (doc.client_id !== clientIdUrl)
    return { ok: false, error: 'client metadata document is not self-referential' }

  const redirectUris = doc.redirect_uris
  const redirectError = validateRegistrableRedirectUris(redirectUris)
  if (redirectError) return { ok: false, error: redirectError }

  const clientHost = validated.url.hostname
  for (const uri of redirectUris as string[]) {
    if (isLoopbackRedirect(uri)) continue
    if (!sameRegistrableDomain(new URL(uri).hostname, clientHost))
      return { ok: false, error: `redirect_uri is not same-site with the client_id URL: ${uri}` }
  }

  const client = await upsertCimdClient({
    clientId: clientIdUrl,
    clientName: typeof doc.client_name === 'string' ? doc.client_name : null,
    clientUri: typeof doc.client_uri === 'string' ? doc.client_uri : null,
    logoUri: typeof doc.logo_uri === 'string' ? doc.logo_uri : null,
    redirectUris: redirectUris as string[],
    raw: doc,
  })

  return { ok: true, client }
}

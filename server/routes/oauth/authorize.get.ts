/**
 * GET /oauth/authorize — front door of the OAuth 2.1 dance.
 *
 * Validates the request, resolves the client (CIMD URL or DCR row), then
 * seals the pending authorization into a flow cookie and hands off to the
 * consent page. No session → bounce through /auth/login?redirect=… and the
 * client retries this exact URL after sign-in.
 *
 * Error discipline (RFC 6749 §4.1.2.1): an unverifiable client_id or
 * redirect_uri renders a 400 — never redirect to an address you couldn't
 * validate. Everything after that pair is validated redirects back to the
 * client with `error=…&state=…`.
 */
import { getQuery, getRequestIP, sendRedirect } from 'h3'
import { checkRateLimit } from '~~/server/utils/rate-limit'
import { getServerSession } from '~~/server/utils/session'
import { isCimdClientId, resolveCimdClient } from '~~/server/utils/oauth-server/cimd'
import { getClient } from '~~/server/utils/oauth-server/store'
import type { OAuthClientRow } from '~~/server/utils/oauth-server/store'
import { isLoopbackRedirect, matchRedirectUri } from '~~/server/utils/oauth-server/redirects'
import { normalizeScope } from '~~/server/utils/oauth-server/scopes'
import { canonicalSiteUrl, remoteMcpResource } from '~~/server/utils/oauth-server/metadata'
import { authzFlowSession } from '~~/server/utils/oauth-server/flow'

function redirectBack(event: Parameters<typeof sendRedirect>[0], redirectUri: string, params: Record<string, string | null>) {
  const target = new URL(redirectUri)
  for (const [key, value] of Object.entries(params)) {
    if (value !== null) target.searchParams.set(key, value)
  }
  return sendRedirect(event, target.toString())
}

export default defineEventHandler(async (event) => {
  if (useRuntimeConfig().authProvider !== 'managed') {
    throw createError({ statusCode: 404, message: 'Not found' })
  }

  // CIMD resolution can trigger an outbound fetch — keep a lid on it.
  const ip = getRequestIP(event, { xForwardedFor: true }) ?? 'unknown'
  const rate = await checkRateLimit(`oauth-authorize:${ip}`, 30, 60_000)
  if (!rate.allowed) {
    throw createError({ statusCode: 429, message: 'Too many authorization requests' })
  }

  const query = getQuery(event) as Record<string, string | undefined>
  const state = query.state ?? null

  // ── Client + redirect_uri: must verify before any redirect is allowed ──
  const clientId = query.client_id
  if (!clientId) {
    throw createError({ statusCode: 400, message: 'invalid_request: client_id is required' })
  }

  let client: OAuthClientRow
  if (isCimdClientId(clientId)) {
    const resolved = await resolveCimdClient(clientId)
    if (!resolved.ok) {
      throw createError({ statusCode: 400, message: `invalid_client: ${resolved.error}` })
    }
    client = resolved.client
  }
  else {
    const row = await getClient(clientId)
    if (!row) {
      throw createError({ statusCode: 400, message: 'invalid_client: unknown client_id' })
    }
    client = row
  }

  const redirectUri = query.redirect_uri
  if (!redirectUri || !matchRedirectUri(client.redirectUris, redirectUri)) {
    throw createError({ statusCode: 400, message: 'invalid_request: redirect_uri is not registered for this client' })
  }

  // ── From here the redirect_uri is trusted: errors go back to the client ──
  if (query.response_type !== 'code') {
    return redirectBack(event, redirectUri, { error: 'unsupported_response_type', state })
  }

  if (!query.code_challenge) {
    return redirectBack(event, redirectUri, {
      error: 'invalid_request',
      error_description: 'code_challenge is required (PKCE)',
      state,
    })
  }
  if ((query.code_challenge_method ?? 'plain') !== 'S256') {
    return redirectBack(event, redirectUri, {
      error: 'invalid_request',
      error_description: 'code_challenge_method must be S256',
      state,
    })
  }

  const scope = normalizeScope(query.scope)
  if (scope === null) {
    return redirectBack(event, redirectUri, { error: 'invalid_scope', state })
  }

  // RFC 8707: when the client names a resource it must be OUR resource.
  const resource = query.resource?.replace(/\/+$/, '') ?? null
  if (resource !== null && resource !== remoteMcpResource()) {
    return redirectBack(event, redirectUri, {
      error: 'invalid_target',
      error_description: 'unknown resource',
      state,
    })
  }

  // ── Studio session: authenticate, then consent ──
  const session = await getServerSession(event)
  if (!session) {
    const returnTo = encodeURIComponent(event.path)
    return sendRedirect(event, `${canonicalSiteUrl()}/auth/login?redirect=${returnTo}`)
  }

  const flow = await authzFlowSession(event)
  await flow.update({
    clientId: client.clientId,
    clientKind: client.kind,
    clientDisplayHost: client.kind === 'cimd'
      ? new URL(client.clientId).hostname
      : (client.clientUri ? new URL(client.clientUri).hostname : (client.clientName ?? 'Unknown application')),
    clientName: client.clientName,
    logoUri: client.logoUri,
    redirectUri,
    scope,
    state,
    codeChallenge: query.code_challenge,
    resource,
    loopbackOnly: client.redirectUris.every(uri => isLoopbackRedirect(uri)),
    createdAt: Date.now(),
  })

  return sendRedirect(event, '/oauth/consent')
})

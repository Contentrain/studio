/**
 * POST /oauth/register — Dynamic Client Registration (RFC 7591).
 *
 * The DCR fallback for clients without CIMD (Codex today; Claude only when
 * CIMD selection fails). Public clients only: PKCE is the proof of
 * possession, so no client_secret is ever minted. Claude's DCR path
 * registers a NEW client per fresh connection — the IP rate limit plus the
 * 30-day orphan cleanup in the store keep the table bounded.
 */
import { getRequestIP, readBody, setResponseHeader, setResponseStatus } from 'h3'
import { checkRateLimit } from '~~/server/utils/rate-limit'
import { createDcrClient } from '~~/server/utils/oauth-server/store'
import { validateRegistrableRedirectUris } from '~~/server/utils/oauth-server/redirects'

const ALLOWED_GRANT_TYPES = new Set(['authorization_code', 'refresh_token'])

function httpsUrlOrNull(value: unknown): string | null {
  if (typeof value !== 'string') return null
  try {
    return new URL(value).protocol === 'https:' ? value : null
  }
  catch {
    return null
  }
}

export default defineEventHandler(async (event) => {
  if (useRuntimeConfig().authProvider !== 'managed') {
    throw createError({ statusCode: 404, message: 'Not found' })
  }

  setResponseHeader(event, 'Cache-Control', 'no-store')

  const ip = getRequestIP(event, { xForwardedFor: true }) ?? 'unknown'
  const rate = await checkRateLimit(`oauth-register:${ip}`, 10, 60_000)
  if (!rate.allowed) {
    setResponseHeader(event, 'Retry-After', Math.max(1, Math.ceil(rate.retryAfterMs / 1000)))
    setResponseStatus(event, 429)
    return { error: 'invalid_client_metadata', error_description: 'rate limit exceeded' }
  }

  const body = await readBody<Record<string, unknown>>(event).catch(() => null)
  if (!body || typeof body !== 'object') {
    setResponseStatus(event, 400)
    return { error: 'invalid_client_metadata', error_description: 'request body must be a JSON object' }
  }

  const redirectError = validateRegistrableRedirectUris(body.redirect_uris)
  if (redirectError) {
    setResponseStatus(event, 400)
    return { error: 'invalid_redirect_uri', error_description: redirectError }
  }
  const redirectUris = body.redirect_uris as string[]

  const grantTypes = Array.isArray(body.grant_types) && body.grant_types.length > 0
    ? body.grant_types
    : ['authorization_code']
  if (grantTypes.some(type => typeof type !== 'string' || !ALLOWED_GRANT_TYPES.has(type))) {
    setResponseStatus(event, 400)
    return { error: 'invalid_client_metadata', error_description: 'only authorization_code and refresh_token grants are supported' }
  }

  const responseTypes = Array.isArray(body.response_types) && body.response_types.length > 0
    ? body.response_types
    : ['code']
  if (responseTypes.some(type => type !== 'code')) {
    setResponseStatus(event, 400)
    return { error: 'invalid_client_metadata', error_description: 'only the code response type is supported' }
  }

  // Public clients only — a requested secret-based auth method is a mismatch.
  const authMethod = body.token_endpoint_auth_method ?? 'none'
  if (authMethod !== 'none') {
    setResponseStatus(event, 400)
    return { error: 'invalid_client_metadata', error_description: 'only public clients (token_endpoint_auth_method "none") are supported' }
  }

  const clientName = typeof body.client_name === 'string' ? body.client_name.slice(0, 256) : null

  const client = await createDcrClient({
    clientName,
    clientUri: httpsUrlOrNull(body.client_uri),
    logoUri: httpsUrlOrNull(body.logo_uri),
    redirectUris,
    metadata: body,
  })

  setResponseStatus(event, 201)
  return {
    client_id: client.clientId,
    client_id_issued_at: Math.floor(Date.now() / 1000),
    token_endpoint_auth_method: 'none' as const,
    redirect_uris: client.redirectUris,
    grant_types: grantTypes,
    response_types: responseTypes,
    ...(client.clientName ? { client_name: client.clientName } : {}),
    ...(client.clientUri ? { client_uri: client.clientUri } : {}),
    ...(client.logoUri ? { logo_uri: client.logoUri } : {}),
  }
})

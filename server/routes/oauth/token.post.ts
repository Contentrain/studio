/**
 * POST /oauth/token — code exchange + refresh rotation.
 *
 * Machine endpoint: accepts application/x-www-form-urlencoded (Claude and
 * ChatGPT send nothing else), answers RFC 6749 JSON with literal error codes
 * (`invalid_grant`, not dictionary copy — a dead refresh token MUST read as
 * invalid_grant or Claude won't re-run the auth flow). Never touches the
 * Studio session cookie.
 */
import type { H3Event } from 'h3'
import { getRequestIP, readBody, setResponseHeader, setResponseStatus } from 'h3'
import { checkRateLimit } from '~~/server/utils/rate-limit'
import {
  cleanupExpired,
  consumeAuthorizationCode,
  issueAccessToken,
  issueRefreshToken,
  rotateRefreshToken,
  touchClient,
  upsertGrant,
} from '~~/server/utils/oauth-server/store'
import { verifyS256Challenge } from '~~/server/utils/oauth-server/pkce'
import { scopeIncludes } from '~~/server/utils/oauth-server/scopes'
import { remoteMcpResource } from '~~/server/utils/oauth-server/metadata'

interface TokenErrorBody {
  error: string
  error_description?: string
}

function tokenError(event: H3Event, status: number, error: string, description?: string): TokenErrorBody {
  setResponseStatus(event, status)
  return description ? { error, error_description: description } : { error }
}

export default defineEventHandler(async (event) => {
  if (useRuntimeConfig().authProvider !== 'managed') {
    throw createError({ statusCode: 404, message: 'Not found' })
  }

  setResponseHeader(event, 'Cache-Control', 'no-store')
  setResponseHeader(event, 'Pragma', 'no-cache')

  const ip = getRequestIP(event, { xForwardedFor: true }) ?? 'unknown'
  const rate = await checkRateLimit(`oauth-token:${ip}`, 60, 60_000)
  if (!rate.allowed) {
    setResponseHeader(event, 'Retry-After', Math.max(1, Math.ceil(rate.retryAfterMs / 1000)))
    return tokenError(event, 429, 'temporarily_unavailable', 'rate limit exceeded')
  }

  // h3 parses both form-urlencoded and JSON bodies into an object.
  const body = await readBody<Record<string, string | undefined>>(event).catch(() => null)
  if (!body || typeof body !== 'object') {
    return tokenError(event, 400, 'invalid_request', 'malformed request body')
  }

  // Best-effort housekeeping — this endpoint sees regular traffic.
  cleanupExpired().catch(() => {})

  if (body.grant_type === 'authorization_code') {
    const { code, redirect_uri, client_id, code_verifier } = body
    if (!code || !redirect_uri || !client_id || !code_verifier) {
      return tokenError(event, 400, 'invalid_request', 'code, redirect_uri, client_id and code_verifier are required')
    }

    const stored = await consumeAuthorizationCode(code)
    if (!stored) {
      return tokenError(event, 400, 'invalid_grant', 'authorization code is invalid, expired or already used')
    }
    if (stored.clientId !== client_id) {
      return tokenError(event, 400, 'invalid_grant', 'client_id does not match the authorization code')
    }
    if (stored.redirectUri !== redirect_uri) {
      return tokenError(event, 400, 'invalid_grant', 'redirect_uri does not match the authorization request')
    }
    if (!verifyS256Challenge(code_verifier, stored.codeChallenge)) {
      return tokenError(event, 400, 'invalid_grant', 'PKCE verification failed')
    }

    // RFC 8707: a resource named here must match the one authorized.
    const resource = body.resource?.replace(/\/+$/, '')
    if (resource && resource !== (stored.resource ?? remoteMcpResource())) {
      return tokenError(event, 400, 'invalid_target', 'unknown resource')
    }

    const { grantId } = await upsertGrant({
      userId: stored.userId,
      clientId: stored.clientId,
      workspaceId: stored.workspaceId,
      projectId: stored.projectId,
      scope: stored.scope,
    })

    const access = await issueAccessToken(grantId)
    const refreshToken = scopeIncludes(stored.scope, 'offline_access')
      ? await issueRefreshToken(grantId)
      : undefined

    touchClient(stored.clientId).catch(() => {})

    return {
      access_token: access.token,
      token_type: 'Bearer' as const,
      expires_in: access.expiresIn,
      ...(refreshToken ? { refresh_token: refreshToken } : {}),
      scope: stored.scope,
    }
  }

  if (body.grant_type === 'refresh_token') {
    if (!body.refresh_token) {
      return tokenError(event, 400, 'invalid_request', 'refresh_token is required')
    }

    const rotated = await rotateRefreshToken(body.refresh_token)
    if (!rotated) {
      return tokenError(event, 400, 'invalid_grant', 'refresh token is invalid, expired or revoked')
    }
    // Public clients aren't secret-authenticated — but when the caller does
    // name itself, the token must belong to that client.
    if (body.client_id && body.client_id !== rotated.grant.clientId) {
      return tokenError(event, 400, 'invalid_grant', 'client_id does not match the refresh token')
    }

    return {
      access_token: rotated.accessToken,
      token_type: 'Bearer' as const,
      expires_in: rotated.accessTokenExpiresIn,
      refresh_token: rotated.refreshToken,
      scope: rotated.grant.scope,
    }
  }

  return tokenError(event, 400, 'unsupported_grant_type')
})

/**
 * HTTP-level auth challenges for the remote MCP resource route.
 *
 * These MUST fire before anything reaches the MCP/JSON-RPC layer: a 200
 * wrapping a tool error never shows Claude's Connect card — only a
 * transport-level 401 with `WWW-Authenticate: Bearer resource_metadata=…`
 * starts the OAuth discovery chain, and only a 403 with
 * `error="insufficient_scope"` triggers the step-up re-consent flow.
 */
import type { H3Event } from 'h3'
import { setResponseHeader } from 'h3'
import { protectedResourceMetadataUrl } from './metadata'
import type { SupportedScope } from './scopes'
import { CHALLENGE_SCOPES, SUPPORTED_SCOPES } from './scopes'

/** 401 — missing/invalid/expired token or revoked grant. */
export function mcpUnauthorized(event: H3Event, description = 'Authentication required'): never {
  setResponseHeader(
    event,
    'WWW-Authenticate',
    `Bearer error="invalid_token", error_description="${description}", `
    + `resource_metadata="${protectedResourceMetadataUrl()}", `
    + `scope="${CHALLENGE_SCOPES.join(' ')}"`,
  )
  throw createError({ statusCode: 401, message: description })
}

/**
 * 403 — valid token, insufficient scope. Per the MCP spec's recommended
 * approach the challenge lists the CURRENT grant scopes plus the newly
 * required one, so the step-up re-consent doesn't drop permissions the
 * user already granted.
 */
export function mcpInsufficientScope(event: H3Event, requiredScope: SupportedScope, grantScope: string): never {
  const current = grantScope.split(' ')
  const requested = SUPPORTED_SCOPES.filter(
    scope => scope === requiredScope || current.includes(scope),
  )

  setResponseHeader(
    event,
    'WWW-Authenticate',
    `Bearer error="insufficient_scope", `
    + `scope="${requested.join(' ')}", `
    + `resource_metadata="${protectedResourceMetadataUrl()}"`,
  )
  throw createError({ statusCode: 403, message: 'insufficient_scope' })
}

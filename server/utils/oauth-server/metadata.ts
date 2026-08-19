/**
 * OAuth discovery documents (RFC 8414 AS metadata + RFC 9728 protected
 * resource metadata). Field set is deliberately exact:
 *
 * - `client_id_metadata_document_supported: true` AND `"none"` in
 *   `token_endpoint_auth_methods_supported` together make Claude pick CIMD
 *   over DCR (its CIMD client authenticates as a public client). Dropping
 *   either silently downgrades every Claude connection to DCR — which
 *   registers a new client row per fresh connection.
 * - `offline_access` in `scopes_supported` is what makes Claude append it
 *   to authorization requests → refresh tokens get issued.
 * - No `openid`/`email`/`profile`: ChatGPT requests any advertised OIDC
 *   scope by default and we issue no ID tokens.
 * - `code_challenge_methods_supported: ["S256"]` is required by the MCP
 *   spec — clients MUST refuse to proceed when it's absent.
 */
import { advertisedScopes } from './scopes'

interface MetadataOptions {
  /** Advertise the media:* scopes (deployment has the media stack). */
  mediaAvailable?: boolean
}

export function canonicalSiteUrl(): string {
  return (useRuntimeConfig().public.siteUrl as string).replace(/\/+$/, '')
}

/** Canonical resource identifier of the remote MCP endpoint (RFC 8707). */
export function remoteMcpResource(siteUrl = canonicalSiteUrl()): string {
  return `${siteUrl}/api/mcp/remote`
}

export function protectedResourceMetadataUrl(siteUrl = canonicalSiteUrl()): string {
  return `${siteUrl}/.well-known/oauth-protected-resource/api/mcp/remote`
}

export function authorizationServerMetadata(siteUrl = canonicalSiteUrl(), opts?: MetadataOptions): Record<string, unknown> {
  return {
    issuer: siteUrl,
    authorization_endpoint: `${siteUrl}/oauth/authorize`,
    token_endpoint: `${siteUrl}/oauth/token`,
    registration_endpoint: `${siteUrl}/oauth/register`,
    scopes_supported: advertisedScopes({ mediaAvailable: opts?.mediaAvailable === true }),
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    token_endpoint_auth_methods_supported: ['none'],
    code_challenge_methods_supported: ['S256'],
    client_id_metadata_document_supported: true,
  }
}

export function protectedResourceMetadata(siteUrl = canonicalSiteUrl(), opts?: MetadataOptions): Record<string, unknown> {
  return {
    resource: remoteMcpResource(siteUrl),
    authorization_servers: [siteUrl],
    scopes_supported: advertisedScopes({ mediaAvailable: opts?.mediaAvailable === true }),
    bearer_methods_supported: ['header'],
  }
}

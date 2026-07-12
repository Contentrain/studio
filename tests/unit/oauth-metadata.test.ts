/**
 * Pins the discovery-document fields MCP clients hard-require:
 * - Claude picks CIMD only when `client_id_metadata_document_supported`
 *   AND `"none"` in `token_endpoint_auth_methods_supported` are BOTH set.
 * - Clients MUST refuse to proceed without `code_challenge_methods_supported: ["S256"]`.
 * - `offline_access` in scopes_supported is what produces refresh tokens.
 * - OIDC scopes must NOT be advertised (ChatGPT requests them by default).
 */
import { describe, expect, it } from 'vitest'
import {
  authorizationServerMetadata,
  protectedResourceMetadata,
  remoteMcpResource,
} from '../../server/utils/oauth-server/metadata'

const SITE = 'https://studio.example'

describe('authorization server metadata (RFC 8414)', () => {
  const meta = authorizationServerMetadata(SITE)

  it('exposes the exact endpoint set', () => {
    expect(meta.issuer).toBe(SITE)
    expect(meta.authorization_endpoint).toBe(`${SITE}/oauth/authorize`)
    expect(meta.token_endpoint).toBe(`${SITE}/oauth/token`)
    expect(meta.registration_endpoint).toBe(`${SITE}/oauth/register`)
  })

  it('advertises the CIMD selection pair Claude checks', () => {
    expect(meta.client_id_metadata_document_supported).toBe(true)
    expect(meta.token_endpoint_auth_methods_supported).toEqual(['none'])
  })

  it('advertises S256 PKCE (clients refuse to proceed without it)', () => {
    expect(meta.code_challenge_methods_supported).toEqual(['S256'])
  })

  it('lists offline_access so Claude requests refresh tokens', () => {
    expect(meta.scopes_supported).toContain('offline_access')
  })

  it('never advertises OIDC scopes', () => {
    for (const scope of ['openid', 'email', 'profile'])
      expect(meta.scopes_supported).not.toContain(scope)
  })

  it('supports exactly the code + refresh grant pair', () => {
    expect(meta.response_types_supported).toEqual(['code'])
    expect(meta.grant_types_supported).toEqual(['authorization_code', 'refresh_token'])
  })
})

describe('protected resource metadata (RFC 9728)', () => {
  const prm = protectedResourceMetadata(SITE)

  it('names the canonical resource without a trailing slash', () => {
    expect(prm.resource).toBe(`${SITE}/api/mcp/remote`)
    expect(remoteMcpResource(SITE)).toBe(`${SITE}/api/mcp/remote`)
  })

  it('points at the issuer as the (single, first) authorization server', () => {
    expect(prm.authorization_servers).toEqual([SITE])
  })

  it('advertises header bearer methods only (tokens never in query strings)', () => {
    expect(prm.bearer_methods_supported).toEqual(['header'])
  })
})

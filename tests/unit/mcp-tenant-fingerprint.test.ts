import { describe, expect, it } from 'vitest'
import { mcpTenantFingerprint } from '../../server/utils/mcp-cloud-runtime'

/**
 * Session ↔ tenant binding for the loopback MCP server (1.10.0
 * `sessionFingerprint`). The fingerprint must be deterministic over the
 * proxy-injected identity headers and absent when they are — a session
 * created for one project must never validate for another.
 */
describe('mcpTenantFingerprint', () => {
  const headers = {
    'x-cr-installation-id': '42',
    'x-cr-repo-owner': 'acme',
    'x-cr-repo-name': 'site',
    'x-cr-content-root': 'content',
  }

  it('derives a stable fingerprint from the tenant headers', () => {
    expect(mcpTenantFingerprint(headers)).toBe('42:acme/site:content')
    expect(mcpTenantFingerprint({ ...headers })).toBe(mcpTenantFingerprint(headers))
  })

  it('changes when any identity component changes', () => {
    const base = mcpTenantFingerprint(headers)
    expect(mcpTenantFingerprint({ ...headers, 'x-cr-installation-id': '43' })).not.toBe(base)
    expect(mcpTenantFingerprint({ ...headers, 'x-cr-repo-name': 'other' })).not.toBe(base)
    expect(mcpTenantFingerprint({ ...headers, 'x-cr-content-root': '' })).not.toBe(base)
  })

  it('returns undefined when required headers are missing or malformed', () => {
    expect(mcpTenantFingerprint({})).toBeUndefined()
    expect(mcpTenantFingerprint({ ...headers, 'x-cr-repo-owner': undefined })).toBeUndefined()
    expect(mcpTenantFingerprint({ ...headers, 'x-cr-installation-id': ['42', '43'] })).toBeUndefined()
  })

  it('treats a missing content root as the empty root', () => {
    const { 'x-cr-content-root': _root, ...rest } = headers
    expect(mcpTenantFingerprint(rest)).toBe('42:acme/site:')
  })
})

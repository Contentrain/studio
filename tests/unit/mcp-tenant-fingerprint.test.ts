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
    // Trailing empty component = no project-id injected (content-only session).
    expect(mcpTenantFingerprint(headers)).toBe('42:acme/site:content:')
    expect(mcpTenantFingerprint({ ...headers })).toBe(mcpTenantFingerprint(headers))
  })

  it('changes when any identity component changes', () => {
    const base = mcpTenantFingerprint(headers)
    expect(mcpTenantFingerprint({ ...headers, 'x-cr-installation-id': '43' })).not.toBe(base)
    expect(mcpTenantFingerprint({ ...headers, 'x-cr-repo-name': 'other' })).not.toBe(base)
    expect(mcpTenantFingerprint({ ...headers, 'x-cr-content-root': '' })).not.toBe(base)
  })

  it('binds the session to the project id when media is eligible', () => {
    const base = mcpTenantFingerprint(headers)
    const withProject = mcpTenantFingerprint({ ...headers, 'x-cr-project-id': 'proj-1' })
    // An eligibility flip (project-id appears/disappears) invalidates the session.
    expect(withProject).not.toBe(base)
    expect(withProject).toBe('42:acme/site:content:proj-1')
    // Two projects sharing repo+root no longer collide.
    expect(mcpTenantFingerprint({ ...headers, 'x-cr-project-id': 'proj-2' })).not.toBe(withProject)
  })

  it('returns undefined when required headers are missing or malformed', () => {
    expect(mcpTenantFingerprint({})).toBeUndefined()
    expect(mcpTenantFingerprint({ ...headers, 'x-cr-repo-owner': undefined })).toBeUndefined()
    expect(mcpTenantFingerprint({ ...headers, 'x-cr-installation-id': ['42', '43'] })).toBeUndefined()
  })

  it('treats a missing content root as the empty root', () => {
    const { 'x-cr-content-root': _root, ...rest } = headers
    expect(mcpTenantFingerprint(rest)).toBe('42:acme/site::')
  })
})

import { describe, expect, it } from 'vitest'
import {
  ADVERTISED_SCOPES,
  SUPPORTED_SCOPES,
  normalizeScope,
  scopeIncludes,
} from '../../server/utils/oauth-server/scopes'

describe('scope registry', () => {
  it('registers six scopes but advertises only the live four', () => {
    expect(SUPPORTED_SCOPES).toHaveLength(6)
    expect(ADVERTISED_SCOPES).toEqual([
      'content:read',
      'content:write',
      'project:metadata',
      'offline_access',
    ])
    // media:* stays registered (grants keep validating) but unadvertised.
    expect(SUPPORTED_SCOPES).toContain('media:read')
    expect(SUPPORTED_SCOPES).toContain('media:write')
    expect(ADVERTISED_SCOPES).not.toContain('media:read')
  })
})

describe('normalizeScope', () => {
  it('defaults an absent scope to least privilege', () => {
    expect(normalizeScope(undefined)).toBe('content:read project:metadata')
    expect(normalizeScope('')).toBe('content:read project:metadata')
    expect(normalizeScope('   ')).toBe('content:read project:metadata')
  })

  it('canonicalizes order and deduplicates', () => {
    expect(normalizeScope('offline_access content:write content:read content:write'))
      .toBe('content:read content:write offline_access')
  })

  it('returns null for unknown members', () => {
    expect(normalizeScope('content:read openid')).toBeNull()
    expect(normalizeScope('admin')).toBeNull()
  })

  it('pads an offline_access-only request with the default scopes', () => {
    expect(normalizeScope('offline_access')).toBe('content:read project:metadata offline_access')
  })

  it('accepts reserved media scopes', () => {
    expect(normalizeScope('media:read content:read')).toBe('content:read media:read')
  })
})

describe('scopeIncludes', () => {
  it('does whole-token matching', () => {
    expect(scopeIncludes('content:read content:write', 'content:write')).toBe(true)
    expect(scopeIncludes('content:readx', 'content:read')).toBe(false)
    expect(scopeIncludes('content:read', 'offline_access')).toBe(false)
  })
})

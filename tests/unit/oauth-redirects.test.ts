import { describe, expect, it } from 'vitest'
import {
  isLoopbackRedirect,
  matchRedirectUri,
  validateRegistrableRedirectUris,
} from '../../server/utils/oauth-server/redirects'

describe('redirect URI matching', () => {
  it('matches exact strings', () => {
    const registered = ['https://claude.ai/api/mcp/auth_callback']
    expect(matchRedirectUri(registered, 'https://claude.ai/api/mcp/auth_callback')).toBe(true)
    expect(matchRedirectUri(registered, 'https://claude.ai/api/mcp/other')).toBe(false)
    expect(matchRedirectUri(registered, 'https://evil.example/api/mcp/auth_callback')).toBe(false)
  })

  it('ignores the port for loopback hosts (RFC 8252 §7.3 + Claude Code CIMD)', () => {
    const registered = ['http://localhost/callback', 'http://127.0.0.1/callback']
    expect(matchRedirectUri(registered, 'http://localhost:53411/callback')).toBe(true)
    expect(matchRedirectUri(registered, 'http://127.0.0.1:61002/callback')).toBe(true)
  })

  it('does not cross-match loopback hosts', () => {
    // A client that declared only localhost must not match 127.0.0.1.
    const registered = ['http://localhost/callback']
    expect(matchRedirectUri(registered, 'http://127.0.0.1:53411/callback')).toBe(false)
  })

  it('loopback match still requires the same scheme and path', () => {
    const registered = ['http://localhost/callback']
    expect(matchRedirectUri(registered, 'http://localhost:4000/other')).toBe(false)
    expect(matchRedirectUri(registered, 'https://localhost:4000/callback')).toBe(false)
  })

  it('never applies port-agnostic matching to non-loopback hosts', () => {
    const registered = ['https://app.example.com/callback']
    expect(matchRedirectUri(registered, 'https://app.example.com:8443/callback')).toBe(false)
  })

  it('detects loopback redirects', () => {
    expect(isLoopbackRedirect('http://localhost:3000/cb')).toBe(true)
    expect(isLoopbackRedirect('http://127.0.0.1/cb')).toBe(true)
    expect(isLoopbackRedirect('https://claude.ai/cb')).toBe(false)
    expect(isLoopbackRedirect('not-a-url')).toBe(false)
  })
})

describe('registration-time redirect validation', () => {
  it('accepts https and loopback http', () => {
    expect(validateRegistrableRedirectUris([
      'https://chatgpt.com/connector/oauth/abc',
      'http://localhost/callback',
      'http://127.0.0.1/callback',
    ])).toBeNull()
  })

  it('rejects plain http on non-loopback hosts', () => {
    expect(validateRegistrableRedirectUris(['http://example.com/cb'])).toMatch(/https/)
  })

  it('rejects fragments, empty lists and non-string entries', () => {
    expect(validateRegistrableRedirectUris(['https://a.example/cb#frag'])).toMatch(/fragment/)
    expect(validateRegistrableRedirectUris([])).toMatch(/non-empty/)
    expect(validateRegistrableRedirectUris('https://a.example/cb')).toMatch(/non-empty/)
    expect(validateRegistrableRedirectUris([42])).toMatch(/strings/)
  })

  it('rejects unparseable URIs', () => {
    expect(validateRegistrableRedirectUris(['/relative/path'])).toMatch(/invalid/)
  })
})

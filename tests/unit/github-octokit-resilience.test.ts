/**
 * Octokit resilience tests — REAL @octokit/rest + plugins, stubbed
 * global fetch. Verifies the W1 rate-limit hardening:
 *
 *  - installation clients are cached per installationId
 *  - a secondary-rate-limit 403 is retried (throttling plugin wiring)
 *
 * `@octokit/auth-app` signs a JWT with a real RSA key generated per
 * test run; the token-exchange endpoint is served by the fetch stub.
 */
import { generateKeyPairSync } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { __resetInstallationOctokitCache, createInstallationOctokit } from '../../server/providers/github-app'

const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
})

const BASE_CONFIG = { appId: '12345', privateKey, installationId: 777 }

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })
}

describe('octokit resilience (real plugins)', () => {
  beforeEach(() => {
    __resetInstallationOctokitCache()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    __resetInstallationOctokitCache()
  })

  it('caches installation clients per installationId', () => {
    const a1 = createInstallationOctokit(BASE_CONFIG)
    const a2 = createInstallationOctokit(BASE_CONFIG)
    const b = createInstallationOctokit({ ...BASE_CONFIG, installationId: 888 })

    expect(a1).toBe(a2)
    expect(b).not.toBe(a1)
  })

  it('retries a secondary-rate-limit 403 and succeeds', async () => {
    let apiAttempts = 0
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/access_tokens')) {
        return jsonResponse(201, {
          token: 'ghs_test-token',
          expires_at: new Date(Date.now() + 3600_000).toISOString(),
          permissions: {},
        })
      }
      apiAttempts += 1
      if (apiAttempts === 1) {
        // Note: the throttling plugin treats a falsy retry-after as
        // "no header" and falls back to a 60s wait — use 1s.
        return jsonResponse(
          403,
          { message: 'You have exceeded a secondary rate limit. Please wait.' },
          { 'retry-after': '1' },
        )
      }
      return jsonResponse(200, { id: 1, full_name: 'acme/site' })
    })
    vi.stubGlobal('fetch', fetchMock)

    const client = createInstallationOctokit(BASE_CONFIG)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const response = await client.request('GET /repos/{owner}/{repo}', { owner: 'acme', repo: 'site' })

    expect(response.status).toBe(200)
    expect(apiAttempts).toBe(2)
    expect(warn.mock.calls.some(c => String(c[0]).includes('[github-throttle] secondary rate limit'))).toBe(true)
    warn.mockRestore()
  }, 20_000)
})

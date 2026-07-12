import { createHash, randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { verifyS256Challenge } from '../../server/utils/oauth-server/pkce'

function challengeFor(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url')
}

describe('PKCE S256 verification', () => {
  it('accepts a matching verifier/challenge pair', () => {
    const verifier = randomBytes(32).toString('base64url') // 43 chars
    expect(verifyS256Challenge(verifier, challengeFor(verifier))).toBe(true)
  })

  it('rejects a wrong verifier', () => {
    const verifier = randomBytes(32).toString('base64url')
    const other = randomBytes(32).toString('base64url')
    expect(verifyS256Challenge(other, challengeFor(verifier))).toBe(false)
  })

  it('rejects verifiers outside the RFC 7636 length bounds', () => {
    const short = 'a'.repeat(42)
    const long = 'a'.repeat(129)
    expect(verifyS256Challenge(short, challengeFor(short))).toBe(false)
    expect(verifyS256Challenge(long, challengeFor(long))).toBe(false)
  })

  it('rejects verifiers with characters outside the unreserved set', () => {
    const bad = `${'a'.repeat(42)}+`
    expect(verifyS256Challenge(bad, challengeFor(bad))).toBe(false)
  })

  it('accepts the full unreserved charset at max length', () => {
    const verifier = `${'aZ9-._~'.repeat(18)}aa` // 128 chars
    expect(verifier).toHaveLength(128)
    expect(verifyS256Challenge(verifier, challengeFor(verifier))).toBe(true)
  })

  it('rejects a challenge of mismatched length without throwing', () => {
    const verifier = randomBytes(32).toString('base64url')
    expect(verifyS256Challenge(verifier, 'short-challenge')).toBe(false)
  })
})

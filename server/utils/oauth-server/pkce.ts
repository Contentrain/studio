/**
 * PKCE (RFC 7636) — S256 only. `plain` is rejected at /oauth/authorize, so
 * verification only ever compares base64url(sha256(verifier)) against the
 * stored challenge.
 */
import { createHash, timingSafeEqual } from 'node:crypto'

// RFC 7636 §4.1: 43-128 chars from the unreserved set.
const VERIFIER_PATTERN = /^[\w\-.~]{43,128}$/

export function verifyS256Challenge(codeVerifier: string, storedChallenge: string): boolean {
  if (!VERIFIER_PATTERN.test(codeVerifier)) return false

  const derived = createHash('sha256').update(codeVerifier).digest('base64url')
  const a = Buffer.from(derived)
  const b = Buffer.from(storedChallenge)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

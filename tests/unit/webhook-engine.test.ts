import { describe, expect, it } from 'vitest'
import { signPayload, verifySignature } from '../../server/utils/webhook-engine'

describe('webhook signature', () => {
  const secret = 'test-webhook-secret-key'
  const payload = '{"event":"content.saved","projectId":"abc"}'

  it('signPayload produces 64-char hex HMAC-SHA256', () => {
    const sig = signPayload(payload, secret)
    expect(sig).toMatch(/^[a-f0-9]{64}$/)
  })

  it('signPayload is deterministic', () => {
    const sig1 = signPayload(payload, secret)
    const sig2 = signPayload(payload, secret)
    expect(sig1).toBe(sig2)
  })

  it('different secrets produce different signatures', () => {
    const sig1 = signPayload(payload, 'secret-a')
    const sig2 = signPayload(payload, 'secret-b')
    expect(sig1).not.toBe(sig2)
  })

  it('different payloads produce different signatures', () => {
    const sig1 = signPayload('payload-a', secret)
    const sig2 = signPayload('payload-b', secret)
    expect(sig1).not.toBe(sig2)
  })

  it('verifySignature returns true for valid signature', () => {
    const sig = signPayload(payload, secret)
    expect(verifySignature(payload, secret, sig)).toBe(true)
  })

  it('verifySignature returns false for tampered payload', () => {
    const sig = signPayload(payload, secret)
    expect(verifySignature(payload + 'x', secret, sig)).toBe(false)
  })

  it('verifySignature returns false for wrong secret', () => {
    const sig = signPayload(payload, secret)
    expect(verifySignature(payload, 'wrong-secret', sig)).toBe(false)
  })

  it('verifySignature returns false for mismatched length', () => {
    expect(verifySignature(payload, secret, 'short')).toBe(false)
  })

  it('verifySignature returns false for completely invalid signature', () => {
    const fakeSig = 'a'.repeat(64)
    expect(verifySignature(payload, secret, fakeSig)).toBe(false)
  })
})

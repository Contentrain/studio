import { describe, expect, it } from 'vitest'
import { decryptApiKey, encryptApiKey, getKeyHint } from '../../server/utils/encryption'

describe('api key encryption', () => {
  it('round-trips API keys with AES-GCM', () => {
    const secret = 'x'.repeat(32)
    const encrypted = encryptApiKey('sk-ant-api03-abcdef', secret)

    expect(encrypted).not.toContain('sk-ant-api03-abcdef')
    expect(decryptApiKey(encrypted, secret)).toBe('sk-ant-api03-abcdef')
  })

  it('fails to decrypt with the wrong secret', () => {
    const encrypted = encryptApiKey('sk-ant-api03-abcdef', 'x'.repeat(32))

    expect(() => decryptApiKey(encrypted, 'y'.repeat(32))).toThrow()
  })

  it('returns a masked display hint for short and long keys', () => {
    expect(getKeyHint('abcd')).toBe('****')
    expect(getKeyHint('sk-ant-api03-abcdef')).toBe('...cdef')
  })
})

import { describe, expect, it } from 'vitest'
import { generateConversationKey, hashConversationKey } from '../../server/utils/conversation-keys'

describe('conversation keys', () => {
  it('generates key with crn_conv_ prefix', () => {
    const { key } = generateConversationKey()
    expect(key.startsWith('crn_conv_')).toBe(true)
  })

  it('generates unique keys on successive calls', () => {
    const a = generateConversationKey()
    const b = generateConversationKey()
    expect(a.key).not.toBe(b.key)
    expect(a.keyHash).not.toBe(b.keyHash)
  })

  it('key prefix is first 16 characters', () => {
    const { key, keyPrefix } = generateConversationKey()
    expect(keyPrefix).toBe(key.substring(0, 16))
    expect(keyPrefix.length).toBe(16)
  })

  it('key hash matches re-hashing the same key', () => {
    const { key, keyHash } = generateConversationKey()
    expect(hashConversationKey(key)).toBe(keyHash)
  })

  it('hash is deterministic', () => {
    const hash1 = hashConversationKey('crn_conv_testkey123')
    const hash2 = hashConversationKey('crn_conv_testkey123')
    expect(hash1).toBe(hash2)
  })

  it('hash is 64-char hex string (SHA-256)', () => {
    const hash = hashConversationKey('crn_conv_testkey')
    expect(hash).toMatch(/^[a-f0-9]{64}$/)
  })

  it('different keys produce different hashes', () => {
    const h1 = hashConversationKey('crn_conv_key_a')
    const h2 = hashConversationKey('crn_conv_key_b')
    expect(h1).not.toBe(h2)
  })
})

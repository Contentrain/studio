import { describe, expect, it, vi } from 'vitest'

// mcp-cloud-keys imports the provider factory at module load; stub it so the
// unit test does not pull the Supabase provider graph.
vi.mock('../../server/utils/providers', () => ({
  useDatabaseProvider: vi.fn(),
}))

const { generateMcpCloudKey, hashMcpCloudKey } = await import('../../server/utils/mcp-cloud-keys')

describe('mcp-cloud-keys', () => {
  it('generates a key with the crn_mcp_ prefix, display prefix, and a matching sha-256 hash', () => {
    const { key, keyHash, keyPrefix } = generateMcpCloudKey()

    expect(key.startsWith('crn_mcp_')).toBe(true)
    expect(keyPrefix).toBe(key.slice(0, 16))
    expect(keyHash).toBe(hashMcpCloudKey(key))
    expect(keyHash).toMatch(/^[a-f0-9]{64}$/)
  })

  it('produces unique keys and hashes across calls', () => {
    const a = generateMcpCloudKey()
    const b = generateMcpCloudKey()

    expect(a.key).not.toBe(b.key)
    expect(a.keyHash).not.toBe(b.keyHash)
  })

  it('hashes deterministically', () => {
    expect(hashMcpCloudKey('crn_mcp_sample')).toBe(hashMcpCloudKey('crn_mcp_sample'))
    expect(hashMcpCloudKey('crn_mcp_a')).not.toBe(hashMcpCloudKey('crn_mcp_b'))
  })
})

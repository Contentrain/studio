import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { auditMethods } from '../../server/providers/supabase-db/audit'

const rpcMock = vi.hoisted(() => vi.fn())

vi.mock('../../server/providers/supabase-db/helpers', () => ({
  getAdmin: () => ({ rpc: rpcMock }),
}))

describe('supabase-db cleanupAuditLogs', () => {
  beforeEach(() => {
    rpcMock.mockReset()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('invokes the retention RPC with the given window and returns the purged count', async () => {
    rpcMock.mockResolvedValue({ data: 42, error: null })

    await expect(auditMethods().cleanupAuditLogs(30)).resolves.toBe(42)
    expect(rpcMock).toHaveBeenCalledWith('cleanup_audit_logs', { retention_days: 30 })
  })

  it('defaults the retention window to 90 days', async () => {
    rpcMock.mockResolvedValue({ data: 0, error: null })

    await expect(auditMethods().cleanupAuditLogs()).resolves.toBe(0)
    expect(rpcMock).toHaveBeenCalledWith('cleanup_audit_logs', { retention_days: 90 })
  })

  it('returns 0 without throwing when the RPC fails', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    rpcMock.mockResolvedValue({ data: null, error: { message: 'boom' } })

    await expect(auditMethods().cleanupAuditLogs(90)).resolves.toBe(0)
    expect(errorSpy).toHaveBeenCalledWith('[audit] Retention cleanup failed:', 'boom')
  })
})

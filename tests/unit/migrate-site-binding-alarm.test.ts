import { describe, expect, it, vi } from 'vitest'

const captureMessage = vi.fn()
vi.mock('@sentry/nuxt', () => ({ captureMessage }))

describe('reportMigrateSiteBindingAlarm', () => {
  it('one ALARM log line for the platform\'s log alert and a Sentry event, carrying ids, the repository, the state and the code only', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { reportMigrateSiteBindingAlarm } = await import('../../server/utils/alert')
    const context = { grantId: 'grant-1', projectId: 'proj-1', repo: 'acme/blog', state: 'failed', code: 'github_unavailable', attempts: 3 }
    reportMigrateSiteBindingAlarm(context)

    expect(error).toHaveBeenCalledTimes(1)
    const [line, logged] = error.mock.calls[0]!
    expect(line).toMatch(/^\[migrate-site-binding\] ALARM grant grant-1: .*\(failed, github_unavailable, 3 attempts\)$/)
    expect(logged).toEqual(context)
    await vi.waitFor(() => expect(captureMessage).toHaveBeenCalledTimes(1))
    expect(captureMessage.mock.calls[0]![1]).toMatchObject({ level: 'error', tags: { migrate_site_binding: 'true', state: 'failed', code: 'github_unavailable' }, extra: context })
    error.mockRestore()
  })
})

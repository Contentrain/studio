import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ build: vi.fn(), deploy: vi.fn(), event: vi.fn() }))
vi.mock('../../server/utils/cdn-build-runner', () => ({ runCDNBuild: mocks.build }))
vi.mock('../../server/utils/deploy-hooks', () => ({ triggerProjectDeploy: mocks.deploy }))
vi.mock('../../server/utils/webhook-engine', () => ({ emitWebhookEvent: mocks.event }))
vi.stubGlobal('defineNitroPlugin', (fn: unknown) => fn)
const { runScheduleTick } = await import('../../server/plugins/schedule-trigger')

describe('schedule delivery acknowledgement', () => {
  const row = { id: 's', claim_token: 'token', project_id: 'p', workspace_id: 'w' }
  const db = { claimDueScheduledPublications: vi.fn(), settleScheduledPublication: vi.fn(),
    getProjectById: vi.fn(), getWorkspaceById: vi.fn(), createCDNBuild: vi.fn() }
  beforeEach(() => {
    vi.stubGlobal('useDatabaseProvider', () => db)
    db.claimDueScheduledPublications.mockResolvedValue([row])
    db.settleScheduledPublication.mockResolvedValue(true)
    db.getProjectById.mockResolvedValue({ cdn_enabled: false })
    mocks.deploy.mockResolvedValue({ ok: true, status: 200 })
    mocks.event.mockResolvedValue(undefined)
  })
  it('waits for the real hook before acknowledging', async () => {
    await runScheduleTick()
    expect(mocks.deploy).toHaveBeenCalledWith({ projectId: 'p', workspaceId: 'w', reason: 'schedule', immediate: true })
    expect(db.settleScheduledPublication).toHaveBeenCalledWith('s', 'token', true, expect.any(Date))
    expect(mocks.deploy.mock.invocationCallOrder[0]).toBeLessThan(db.settleScheduledPublication.mock.invocationCallOrder[0]!)
  })
  it('retries hook failures without announcing delivery', async () => {
    mocks.deploy.mockResolvedValue({ ok: false, status: 503 })
    await runScheduleTick()
    expect(db.settleScheduledPublication).toHaveBeenCalledWith('s', 'token', false, expect.any(Date))
    expect(mocks.event).not.toHaveBeenCalled()
  })
  it('retries when configured CDN delivery has no provider', async () => {
    db.getProjectById.mockResolvedValue({ cdn_enabled: true })
    vi.stubGlobal('useCDNProvider', () => null)
    await runScheduleTick()
    expect(mocks.deploy).not.toHaveBeenCalled()
    expect(db.settleScheduledPublication).toHaveBeenCalledWith('s', 'token', false, expect.any(Date))
  })
  it.each(['busy', 'failed'])('retries a %s CDN build before firing the hook', async (state) => {
    db.getProjectById.mockResolvedValue({ cdn_enabled: true, repo_full_name: 'owner/repo' })
    db.getWorkspaceById.mockResolvedValue({ github_installation_id: 1 })
    db.createCDNBuild.mockResolvedValue(state === 'busy' ? null : { id: 'build' })
    vi.stubGlobal('useCDNProvider', () => ({}))
    vi.stubGlobal('useGitProvider', () => ({ listBranches: async () => [{ name: 'main', sha: 'sha' }] }))
    vi.stubGlobal('normalizeContentRoot', () => '')
    mocks.build.mockResolvedValue({ error: 'upload failed' })
    await runScheduleTick()
    expect(mocks.deploy).not.toHaveBeenCalled()
    expect(db.settleScheduledPublication).toHaveBeenCalledWith('s', 'token', false, expect.any(Date))
  })
})

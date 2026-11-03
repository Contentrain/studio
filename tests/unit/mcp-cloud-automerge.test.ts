import type { ApprovalPolicyFile } from '@contentrain/types'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// ── Mocks ────────────────────────────────────────────
// git, the engine, the plan and the brain are mocked; the approval gate is
// the real one, so these tests pin what lands under which policy.

const engine = {
  mergeToContentrain: vi.fn(),
  finalizeContentrain: vi.fn(),
}
const invalidateBrainCache = vi.fn()
const branchWriteSignals = vi.fn()
let hasReviewFeature = true
let brain: { config: Record<string, unknown> | null, approvalPolicy: ApprovalPolicyFile | null, models: Map<string, { kind: string }> }

vi.mock('../../server/utils/providers', () => ({
  useGitProvider: vi.fn(() => ({})),
  useDatabaseProvider: vi.fn(),
}))
vi.mock('../../server/utils/content-engine', () => ({
  createContentEngine: vi.fn(() => engine),
}))
vi.mock('../../server/utils/license', () => ({
  hasFeature: vi.fn(() => hasReviewFeature),
}))
vi.mock('../../server/utils/brain-cache', () => ({
  invalidateBrainCache,
  getOrBuildBrainCache: vi.fn(async () => brain),
}))
vi.mock('../../server/utils/branch-approval', () => ({
  branchWriteSignals,
}))

const { reconcileMcpCloudWrites } = await import('../../server/utils/mcp-cloud-automerge')

const baseParams = {
  workspaceId: 'ws-1',
  projectId: 'proj-1',
  installationId: 123,
  repoFullName: 'owner/repo',
  contentRoot: '',
  plan: 'pro' as never,
}

const BRANCH = 'cr/content/posts/en/1-aa'
const save = { tool: 'contentrain_content_save', arguments: { model: 'posts', entries: [{ id: 'p1', locale: 'en', data: { title: 'Hi' } }] }, branch: BRANCH, commitSha: 'c1' }

/** The owner's own choice: one-entry content edits merge without a person, everything else needs one. */
const autoContent: ApprovalPolicyFile = { version: 1, default_mode: 'single', rules: [{ risk: 'low_risk_content', gate: 'change', mode: 'auto' }] }

describe('reconcileMcpCloudWrites', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    hasReviewFeature = true
    brain = { config: { workflow: 'auto-merge', locales: { default: 'en', supported: ['en', 'tr'] } }, approvalPolicy: null, models: new Map([['posts', { kind: 'collection' }]]) }
    engine.mergeToContentrain.mockResolvedValue({ merged: true, sha: 'm' })
    engine.finalizeContentrain.mockResolvedValue({ merged: true, sha: 'm', pullRequestUrl: null })
    branchWriteSignals.mockResolvedValue({})
  })

  it('lands the call\'s branch on an auto-merge project', async () => {
    const outcomes = await reconcileMcpCloudWrites(baseParams, [save])

    expect(engine.mergeToContentrain).toHaveBeenCalledWith(BRANCH)
    expect(outcomes.get(BRANCH)).toEqual({ status: 'merged' })
    expect(invalidateBrainCache).toHaveBeenCalledWith('proj-1')
  })

  it('judges only the branch this call produced, never another pending one', async () => {
    await reconcileMcpCloudWrites(baseParams, [save])

    expect(engine.mergeToContentrain).toHaveBeenCalledTimes(1)
    expect(engine.mergeToContentrain).toHaveBeenCalledWith(BRANCH)
    expect(engine.finalizeContentrain).toHaveBeenCalledWith([BRANCH])
  })

  it('holds the write on a review project under the default policy, and says why', async () => {
    brain.config = { ...brain.config, workflow: 'review' }

    const outcomes = await reconcileMcpCloudWrites(baseParams, [save])

    expect(engine.mergeToContentrain).not.toHaveBeenCalled()
    const outcome = outcomes.get(BRANCH)
    expect(outcome?.status).toBe('held')
    expect(outcome && 'approval' in outcome ? outcome.approval?.risk : null).toBe('low_risk_content')
    expect(invalidateBrainCache).not.toHaveBeenCalled()
  })

  it('lands a low-risk write on a review project whose policy lets it through, as the UI route would', async () => {
    brain.config = { ...brain.config, workflow: 'review' }
    brain.approvalPolicy = autoContent

    const outcomes = await reconcileMcpCloudWrites(baseParams, [save])

    expect(outcomes.get(BRANCH)).toEqual({ status: 'merged' })
    // The branch's own review was read for emptied fields, as the save route does.
    expect(branchWriteSignals).toHaveBeenCalledWith(expect.objectContaining({ branch: BRANCH }))
  })

  it('holds a publish under that same policy: a status change to published is not a content edit', async () => {
    brain.config = { ...brain.config, workflow: 'review' }
    brain.approvalPolicy = autoContent
    const publish = { tool: 'contentrain_content_status', arguments: { model: 'posts', status: 'published', entry_ids: ['p1'] }, branch: 'cr/status/posts' }

    const outcomes = await reconcileMcpCloudWrites(baseParams, [publish])

    expect(outcomes.get('cr/status/posts')?.status).toBe('held')
    expect(engine.mergeToContentrain).not.toHaveBeenCalled()
  })

  it('counts every supported locale when content_status names none', async () => {
    brain.config = { ...brain.config, workflow: 'review' }
    const { mcpWriteScope } = await import('../../server/utils/mcp-cloud-automerge')
    const { scope } = mcpWriteScope('contentrain_content_status', { model: 'posts', status: 'draft', entry_ids: ['p1'] }, {
      defaultLocale: 'en',
      supportedLocales: ['en', 'tr'],
      kindOf: () => 'collection',
    })
    expect(scope.locales).toEqual(['en', 'tr'])
  })

  it('forces auto-merge when the plan lacks workflow.review even if config says review', async () => {
    hasReviewFeature = false
    brain.config = { ...brain.config, workflow: 'review' }

    const outcomes = await reconcileMcpCloudWrites(baseParams, [save])

    expect(outcomes.get(BRANCH)).toEqual({ status: 'merged' })
  })

  it('leaves a write the policy cannot classify pending', async () => {
    const outcomes = await reconcileMcpCloudWrites(baseParams, [{ ...save, tool: 'contentrain_bulk' }])

    expect(outcomes.get(BRANCH)).toEqual({ status: 'pending' })
    expect(engine.mergeToContentrain).not.toHaveBeenCalled()
  })

  it('resolves before the finalize completes — the caller waits on step 1 only', async () => {
    let releaseFinalize: () => void = () => {}
    const finalizeDone = new Promise<void>((resolve) => {
      releaseFinalize = resolve
    })
    engine.finalizeContentrain.mockReturnValue(finalizeDone)

    // Would hang if the reconciler awaited step 2.
    await expect(reconcileMcpCloudWrites(baseParams, [save])).resolves.toBeInstanceOf(Map)
    releaseFinalize()
    await finalizeDone
  })

  it('invalidates the brain cache again once the finalize lands', async () => {
    await reconcileMcpCloudWrites(baseParams, [save])
    await vi.waitFor(() => expect(invalidateBrainCache).toHaveBeenCalledTimes(2))
  })

  it('never throws when a merge fails, and reports the branch pending', async () => {
    engine.mergeToContentrain.mockRejectedValue(new Error('merge conflict'))

    const outcomes = await reconcileMcpCloudWrites(baseParams, [save])

    expect(outcomes.get(BRANCH)).toEqual({ status: 'pending' })
    expect(invalidateBrainCache).not.toHaveBeenCalled()
    expect(engine.finalizeContentrain).not.toHaveBeenCalled()
  })

  it('no-ops on an invalid repo full name', async () => {
    const outcomes = await reconcileMcpCloudWrites({ ...baseParams, repoFullName: 'invalid' }, [save])

    expect(outcomes.size).toBe(0)
    expect(engine.mergeToContentrain).not.toHaveBeenCalled()
  })
})

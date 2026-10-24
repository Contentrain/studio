import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The setup's live-site check: one check file written to the site with a fresh nonce, merged under the owner's click
 * (`mergeOnClick`), then looked for on the live site through the guarded fetch. Studio's write path is simulated as in
 * the site binding's test: a merge lands the branch unless the default branch is protected.
 */

let workflow: string | undefined
let protectedMain: boolean
let policyWantsMore: boolean
let conflict: boolean
let commits: Array<{ branch: string, changes: Array<{ path: string, content: string }>, message: string }>
let mergedBranches: string[]
const PR = 'https://github.com/acme/site/pull/7'

vi.mock('../../server/utils/brain-cache', () => ({
  getOrBuildBrainCache: async () => ({ models: new Map(), config: workflow ? { workflow } : null }),
  invalidateBrainCache: () => {},
}))
vi.mock('../../server/utils/license', () => ({
  hasFeature: (_plan: string, feature: string) => feature === 'workflow.review',
}))
vi.mock('../../server/utils/migration-media', async importOriginal => ({
  ...(await importOriginal<typeof import('../../server/utils/migration-media')>()),
  readMigrationMediaManifest: async () => ({ root: 'site', manifest: { version: 1, assets: [] } }),
}))
vi.mock('../../server/utils/content-engine/helpers', () => ({
  createFeatureBranch: async () => ({ branchName: 'cr/studio/live-check/1' }),
  openWriteSnapshot: async () => ({ baseSha: 'base' }),
  writeBase: () => 'base',
}))
const receipts = vi.fn(async (_input: unknown) => {})
vi.mock('../../server/utils/branch-approval', async importOriginal => ({
  ...(await importOriginal<typeof import('../../server/utils/branch-approval')>()),
  resolveMergeApproval: async (input: { branch: string }) => {
    const granted = db.recordApproval.mock.calls.some(([grant]) => grant.target === input.branch)
    return {
      plan: { plan_hash: `hash-${input.branch}` },
      grants: [],
      commitSha: 'tip',
      decision: { allowed: granted && !policyWantsMore, risk: 'low_risk_content', planHash: `hash-${input.branch}`, intent: '', scope: {}, reasons: [], requirements: [{ gate: 'plan' }], rejectedGrants: [] },
    }
  },
  recordMergeReceipt: (input: unknown) => receipts(input),
}))
vi.mock('../../server/utils/content-engine', () => ({
  createContentEngine: () => ({
    ensureContentBranch: async () => {},
    mergeBranch: async (branch: string, options?: { expectedHead?: string }) => {
      mergedBranches.push(`${branch}@${options?.expectedHead ?? ''}`)
      if (conflict) return { merged: false, sha: null, pullRequestUrl: null, conflict: true }
      return protectedMain ? { merged: false, sha: null, pullRequestUrl: PR } : { merged: true, sha: 'm', pullRequestUrl: null }
    },
  }),
}))

const git = {
  applyPlan: async (input: { branch: string, changes: Array<{ path: string, content: string }>, message: string }) => {
    commits.push({ branch: input.branch, changes: input.changes, message: input.message })
    return { sha: 'c1' }
  },
  deleteBranch: vi.fn(async () => {}),
}
const db = { recordApproval: vi.fn(async (input: { target: string } & Record<string, unknown>) => input) }
const OWNER = { id: 'user-1', email: 'owner@example.com', role: 'owner', workspaceId: 'ws-1' }

async function check() {
  const { writeLiveCheck } = await import('../../server/utils/migration-live-check')
  return writeLiveCheck({ db, git: git as never, contentRoot: '', projectId: 'proj-1', plan: 'pro', defaultBranch: 'main', approver: OWNER, now: () => new Date('2026-10-24T10:00:00Z') })
}

beforeEach(() => {
  vi.resetModules()
  workflow = undefined
  protectedMain = false
  policyWantsMore = false
  conflict = false
  commits = []
  mergedBranches = []
  db.recordApproval.mockClear()
  git.deleteBranch.mockClear()
  receipts.mockClear()
  vi.stubGlobal('errorMessage', (key: string) => key)
  vi.stubGlobal('createError', (input: { statusCode: number, message: string }) => Object.assign(new Error(input.message), { statusCode: input.statusCode }))
})

describe('writeLiveCheck (the test change)', () => {
  it('one file under the site root with a fresh nonce, a commit that says the customer may delete it; merged', async () => {
    const first = await check()
    expect(first).toMatchObject({ status: 'merged', branch: 'cr/studio/live-check/1', pullRequestUrl: null, at: '2026-10-24T10:00:00.000Z', seenAt: null })
    expect(commits).toHaveLength(1)
    expect(commits[0]!.changes).toEqual([{ path: 'site/public/.well-known/contentrain-check.txt', content: expect.stringContaining(`check: ${first.nonce}`) }])
    expect(commits[0]!.message).toContain('You can delete it')
    // Every check rewrites the same file with a new nonce.
    const second = await check()
    expect(second.nonce).not.toBe(first.nonce)
    expect(commits[1]!.changes[0]!.path).toBe(commits[0]!.changes[0]!.path)
  })

  it('a review project: the click is the approval, recorded with the clicker\'s role, merged under the approved tip', async () => {
    workflow = 'review'
    expect(await check()).toMatchObject({ status: 'merged' })
    expect(db.recordApproval.mock.calls[0]![0]).toMatchObject({ target: 'cr/studio/live-check/1', approverId: 'user-1', approverRole: 'owner', note: 'check the live site' })
    expect(mergedBranches).toEqual(['cr/studio/live-check/1@tip'])
    expect(receipts).toHaveBeenCalledTimes(1)
  })

  it('a review policy that wants more than one grant: held for its reviewers, nothing merged', async () => {
    workflow = 'review'
    policyWantsMore = true
    expect(await check()).toMatchObject({ status: 'pending_review', branch: 'cr/studio/live-check/1' })
    expect(mergedBranches).toEqual([])
  })

  it('a protected default branch: the pull request; a conflict: 409, the branch removed, nothing overwritten', async () => {
    protectedMain = true
    expect(await check()).toMatchObject({ status: 'pull_request', pullRequestUrl: PR })
    protectedMain = false
    conflict = true
    await expect(check()).rejects.toMatchObject({ statusCode: 409, message: 'migration.live_check_conflict' })
    expect(git.deleteBranch).toHaveBeenCalledWith('cr/studio/live-check/1')
  })
})

describe('liveSiteShowsCheck (looking on the live site)', () => {
  it('asks the live site for its own check address, https only, through the guarded fetch', async () => {
    const { liveCheckUrl } = await import('../../server/utils/migration-live-check')
    expect(liveCheckUrl('https://acme.com', 'n1')).toBe('https://acme.com/.well-known/contentrain-check.txt?check=n1')
    expect(liveCheckUrl('https://acme.com/blog?x=1#a', 'n1')).toBe('https://acme.com/blog/.well-known/contentrain-check.txt?check=n1')
    expect(liveCheckUrl('http://acme.com', 'n1')).toBeNull()
    expect(liveCheckUrl('https://user:pw@acme.com', 'n1')).toBeNull()
    expect(liveCheckUrl('not a url', 'n1')).toBeNull()
  })

  it('seen only when the nonce is there; any failure is "not yet"', async () => {
    const { liveCheckSource, liveSiteShowsCheck } = await import('../../server/utils/migration-live-check')
    const serving = (body: string) => vi.fn(async () => ({ buffer: Buffer.from(body), contentType: 'text/plain', url: 'u' }))
    const fetch = serving(liveCheckSource('n1'))
    expect(await liveSiteShowsCheck('https://acme.com', 'n1', fetch as never)).toBe(true)
    expect(fetch).toHaveBeenCalledWith('https://acme.com/.well-known/contentrain-check.txt?check=n1', 'https://acme.com/.well-known/contentrain-check.txt?check=n1', expect.objectContaining({ maxBytes: 4096 }))
    expect(await liveSiteShowsCheck('https://acme.com', 'n2', serving(liveCheckSource('n1')) as never)).toBe(false)
    expect(await liveSiteShowsCheck('https://acme.com', 'n1', vi.fn(async () => Promise.reject(new Error('blocked_address'))) as never)).toBe(false)
    expect(await liveSiteShowsCheck('http://acme.com', 'n1', fetch as never)).toBe(false)
  })
})

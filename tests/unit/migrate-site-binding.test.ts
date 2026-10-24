import { CONTENTRAIN_BRANCH } from '@contentrain/types'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The bundle's site binding (`ensureMigrateSiteBinding`) over a repository in memory, in the shape a Migrate delivery
 * has: the writer's form model in `.contentrain/models/contact.json` (plan/behaviors.ts `formModel`), no studio.json
 * until Studio writes one. Studio's write path (`createFeatureBranch` → `applyPlan` → `mergeBranch`) is the real
 * contract, simulated: a merge lands the branch on `contentrain` and, unless the default branch is protected, on it too.
 */

// The writer's form model, as Migrate delivers it.
const CONTACT = { id: 'contact', name: 'Contact form', kind: 'collection', fields: { name: { type: 'string' }, email: { type: 'email' }, message: { type: 'text' } }, form: { enabled: true, public: true, exposedFields: ['name', 'email', 'message'], honeypot: true, captcha: 'turnstile', notifications: true } }
const NEWSLETTER = { ...CONTACT, id: 'newsletter', name: 'Newsletter', form: { ...CONTACT.form, exposedFields: ['email'] } }

let models: Map<string, unknown>
let limit: number
let workflow: string | undefined
let protectedMain: boolean
let failWrite: boolean
let branches: Record<string, Map<string, string>>
let commits: Array<{ branch: string, changes: Array<{ path: string, content: string }>, message: string }>
let finalizeCalls: number
let merged: Set<string>
let policyWantsMore: boolean
const PR = 'https://github.com/ABB65/formchickens/pull/12'

vi.mock('../../server/utils/brain-cache', () => ({
  getOrBuildBrainCache: async () => ({ models, config: workflow ? { workflow } : null }),
  invalidateBrainCache: () => {},
}))
vi.mock('../../server/utils/license', () => ({
  getPlanLimit: (_plan: string, key: string) => (key === 'forms.models' ? limit : 0),
  hasFeature: (_plan: string, feature: string) => feature === 'workflow.review',
}))
vi.mock('../../server/utils/migration-media', async importOriginal => ({
  ...(await importOriginal<typeof import('../../server/utils/migration-media')>()),
  readMigrationMediaManifest: async () => null,
}))
vi.mock('../../server/utils/content-engine/helpers', () => ({
  createFeatureBranch: async () => ({ branchName: 'cr/studio/binding/1' }),
  openWriteSnapshot: async () => ({ baseSha: 'base' }),
  writeBase: () => 'base',
}))
// The approval a merge answers to, over the grants recorded: allowed once the owner's grant is on the branch, unless the
// policy wants more than one person.
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
// Studio's two-step merge: cr/* → contentrain, then contentrain → main (a pull request when main is protected).
const finalize = () => {
  if (protectedMain) return { merged: false, sha: null, pullRequestUrl: PR }
  for (const [path, content] of branches[CONTENTRAIN_BRANCH]!) branches.main!.set(path, content)
  return { merged: true, sha: 'm', pullRequestUrl: null }
}
vi.mock('../../server/utils/content-engine', () => ({
  createContentEngine: () => ({
    ensureContentBranch: async () => {},
    mergeBranch: async (branch: string) => {
      for (const [path, content] of branches[branch]!) branches[CONTENTRAIN_BRANCH]!.set(path, content)
      merged.add(branch)
      return finalize()
    },
    finalizeContentrain: async () => {
      finalizeCalls++
      return finalize()
    },
  }),
}))

const git = {
  readFile: async (path: string, ref?: string) => {
    const value = branches[ref ?? CONTENTRAIN_BRANCH]?.get(path)
    if (value === undefined) throw Object.assign(new Error('Not Found'), { status: 404 })
    return value
  },
  applyPlan: async (input: { branch: string, changes: Array<{ path: string, content: string }>, message: string }) => {
    if (failWrite) throw Object.assign(new Error('GitHub 502'), { code: 'github_unavailable' })
    commits.push({ branch: input.branch, changes: input.changes, message: input.message })
    branches[input.branch] = new Map(input.changes.map(c => [c.path, c.content]))
    return { sha: 'c1' }
  },
  listBranches: async (prefix?: string) => Object.keys(branches).filter(name => !prefix || name.startsWith(prefix)).map(name => ({ name })),
  isMerged: async (branch: string) => merged.has(branch),
}

const db = {
  setMigrateGrantSiteBinding: vi.fn(async (_id: string, _b: unknown) => {}),
  recordApproval: vi.fn(async (input: { target: string } & Record<string, unknown>) => input),
}
const OWNER = { id: 'user-1', email: 'owner@example.com', workspaceId: 'ws-1' }
const STUDIO = { baseUrl: 'https://studio.contentrain.io', mediaBaseUrl: 'https://studio.contentrain.io/api/cdn/v1/proj-1' }

async function bind(over: { projectId?: string, approver?: typeof OWNER & { role?: string | null }, recordedBranch?: string } = {}) {
  const { ensureMigrateSiteBinding } = await import('../../server/utils/migrate-site-binding')
  return ensureMigrateSiteBinding({ db, grantId: 'grant-1', projectId: over.projectId ?? 'proj-1', git: git as never, contentRoot: '', defaultBranch: 'main', plan: 'pro', studio: STUDIO, ...(over.approver ? { approver: over.approver } : {}), ...(over.recordedBranch ? { recordedBranch: over.recordedBranch } : {}) })
}
const recorded = () => db.setMigrateGrantSiteBinding.mock.calls.at(-1)?.[1] as { state: string, detail: Record<string, unknown>, attempts?: number, nextAt?: Date | null }

beforeEach(() => {
  vi.resetModules()
  models = new Map([['contact', CONTACT]])
  limit = 3
  workflow = undefined
  protectedMain = false
  failWrite = false
  branches = { main: new Map(), [CONTENTRAIN_BRANCH]: new Map() }
  commits = []
  finalizeCalls = 0
  merged = new Set()
  policyWantsMore = false
  db.setMigrateGrantSiteBinding.mockClear()
  db.recordApproval.mockClear()
  receipts.mockClear()
})

describe('ensureMigrateSiteBinding (forms work on the delivered site)', () => {
  it('no studio.json: one commit with exactly { baseUrl, projectId }, an honest message, landed on main; state written', async () => {
    expect(await bind()).toEqual({ state: 'written' })
    expect(commits).toHaveLength(1)
    const [commit] = commits
    expect(commit!.changes.map(c => c.path)).toEqual(['studio.json'])
    // The media base is the one the starter derives itself, so it is not written (same bytes as the media apply).
    expect(JSON.parse(commit!.changes[0]!.content)).toEqual({ baseUrl: 'https://studio.contentrain.io', projectId: 'proj-1' })
    expect(commit!.message.split('\n')[0]).toBe('contentrain: connect this site to Contentrain Studio (forms and comments)')
    expect(commit!.message).toContain('Your host rebuilds the site on this commit.')
    expect(branches.main!.get('studio.json')).toBe(commit!.changes[0]!.content)
    expect(recorded()).toEqual({ state: 'written', detail: { path: 'studio.json', change: 'written', formModels: 1, limit: 3 }, attempts: 0, nextAt: null })
  })

  it('a studio.json for the same project: nothing written; the retry is a no-op', async () => {
    await bind()
    await bind()
    await bind()
    expect(commits).toHaveLength(1)
    expect(recorded()).toMatchObject({ state: 'written', detail: { change: 'already' } })
  })

  it('a studio.json that points at another project, or does not read as one: never touched; conflict with both values', async () => {
    const other = JSON.stringify({ baseUrl: 'https://studio.contentrain.io', projectId: 'someone-else' })
    branches.main!.set('studio.json', other)
    expect(await bind()).toEqual({ state: 'conflict' })
    expect(commits).toEqual([])
    expect(branches.main!.get('studio.json')).toBe(other)
    expect(recorded().detail).toEqual({ path: 'studio.json', found: { baseUrl: 'https://studio.contentrain.io', projectId: 'someone-else' }, expected: { baseUrl: 'https://studio.contentrain.io', projectId: 'proj-1' } })

    branches.main!.set('studio.json', '{ not json')
    expect(await bind()).toEqual({ state: 'conflict' })
    expect(recorded().detail).toMatchObject({ found: { unreadable: true } })
    expect(commits).toEqual([])
  })

  it('more form models than the plan serves: written anyway; partial names the ones over the limit (first N by id serve)', async () => {
    models = new Map([['newsletter', NEWSLETTER], ['contact', CONTACT], ['page', { id: 'page', kind: 'collection', fields: {} }]])
    limit = 1
    expect(await bind()).toEqual({ state: 'partial', overLimit: ['newsletter'] })
    expect(commits).toHaveLength(1)
    expect(recorded()).toEqual({ state: 'partial', detail: { path: 'studio.json', change: 'written', formModels: 2, limit: 1, overLimit: ['newsletter'] }, attempts: 0, nextAt: null })
  })

  it('a protected main: the same single file in a pull request (pr_open); a retry opens no second one; once merged, written', async () => {
    protectedMain = true
    expect(await bind()).toEqual({ state: 'pr_open', prUrl: PR })
    expect(commits).toHaveLength(1)
    expect(commits[0]!.changes.map(c => c.path)).toEqual(['studio.json'])
    expect(branches.main!.has('studio.json')).toBe(false)
    expect(recorded()).toEqual({ state: 'pr_open', detail: { path: 'studio.json', prUrl: PR }, attempts: 0, nextAt: null })

    // The claim screen's retry while the pull request waits: nothing committed again, only the merge asked for.
    expect(await bind()).toEqual({ state: 'pr_open', prUrl: PR })
    expect(commits).toHaveLength(1)
    expect(finalizeCalls).toBe(1)

    // The customer merged it.
    branches.main!.set('studio.json', branches[CONTENTRAIN_BRANCH]!.get('studio.json')!)
    expect(await bind()).toEqual({ state: 'written' })
    expect(commits).toHaveLength(1)
  })

  it('a review project: the owner\'s Connect is the approval — recorded on the branch\'s plan, merged under it, receipt; written', async () => {
    workflow = 'review'
    expect(await bind({ approver: OWNER })).toEqual({ state: 'written' })
    expect(db.recordApproval).toHaveBeenCalledTimes(1)
    expect(db.recordApproval.mock.calls[0]![0]).toEqual({
      projectId: 'proj-1',
      workspaceId: 'ws-1',
      target: 'cr/studio/binding/1',
      gate: 'plan',
      planHash: 'hash-cr/studio/binding/1',
      commitSha: 'tip',
      approverId: 'user-1',
      approverEmail: 'owner@example.com',
      approverRole: null,
      note: 'connect this site to Studio',
    })
    expect(branches.main!.get('studio.json')).toBe(commits[0]!.changes[0]!.content)
    expect(receipts).toHaveBeenCalledWith(expect.objectContaining({ projectId: 'proj-1', workspaceId: 'ws-1', branch: 'cr/studio/binding/1', actor: { kind: 'human', id: 'owner@example.com', name: 'owner@example.com' } }))
    expect(recorded()).toMatchObject({ state: 'written', detail: { change: 'written' } })
  })

  it('the setup\'s retry: the clicker is the approver, with their role', async () => {
    workflow = 'review'
    expect(await bind({ approver: { ...OWNER, id: 'admin-2', email: 'admin@example.com', role: 'admin' } })).toEqual({ state: 'written' })
    expect(db.recordApproval.mock.calls[0]![0]).toMatchObject({ approverId: 'admin-2', approverEmail: 'admin@example.com', approverRole: 'admin', note: 'connect this site to Studio' })
  })

  it('a review project whose policy wants more than the owner\'s grant: the binding waits for its reviewers (pr_open), nothing merged', async () => {
    workflow = 'review'
    policyWantsMore = true
    expect(await bind({ approver: OWNER })).toEqual({ state: 'pr_open', prUrl: null })
    expect(branches[CONTENTRAIN_BRANCH]!.has('studio.json')).toBe(false)
    expect(receipts).not.toHaveBeenCalled()
    expect(recorded()).toMatchObject({ state: 'pr_open', detail: { branch: 'cr/studio/binding/1', review: true } })
  })

  it('a retry merges the recorded branch first, never a second binding branch; older duplicates are listed, never deleted', async () => {
    workflow = 'review'
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await bind()
    branches['cr/studio/binding/2'] = new Map(branches['cr/studio/binding/1']!)
    expect(await bind({ approver: OWNER, recordedBranch: 'cr/studio/binding/1' })).toEqual({ state: 'written' })
    expect(commits).toHaveLength(1)
    expect(merged).toEqual(new Set(['cr/studio/binding/1']))
    expect(recorded()).toMatchObject({ state: 'written', detail: { change: 'written', duplicateBranches: ['cr/studio/binding/2'] } })
    expect(warn).toHaveBeenCalledWith('[migrate-site-binding] duplicate binding branches (list only)', { grantId: 'grant-1', projectId: 'proj-1', branches: ['cr/studio/binding/2'] })
    expect(branches['cr/studio/binding/2']).toBeDefined()
  })

  it('a review project with no owner to approve: the change waits on its branch for review (pr_open, no address), nothing merged', async () => {
    workflow = 'review'
    expect(await bind()).toEqual({ state: 'pr_open', prUrl: null })
    expect(branches[CONTENTRAIN_BRANCH]!.has('studio.json')).toBe(false)
    expect(recorded()).toMatchObject({ state: 'pr_open', detail: { branch: 'cr/studio/binding/1', review: true } })
  })

  it('a review project: Try again finds the branch already waiting and commits nothing; once the review is merged, written', async () => {
    workflow = 'review'
    await bind()
    expect(await bind()).toEqual({ state: 'pr_open', prUrl: null })
    expect(await bind()).toEqual({ state: 'pr_open', prUrl: null })
    expect(commits).toHaveLength(1)
    expect(recorded()).toMatchObject({ state: 'pr_open', detail: { branch: 'cr/studio/binding/1' } })

    // The reviewer approves in Studio: the branch lands on contentrain, then on main.
    for (const [path, content] of branches['cr/studio/binding/1']!) branches[CONTENTRAIN_BRANCH]!.set(path, content)
    merged.add('cr/studio/binding/1')
    finalize()
    expect(await bind()).toEqual({ state: 'written' })
    expect(commits).toHaveLength(1)
  })

  it('a waiting binding branch for another project is not reused', async () => {
    workflow = 'review'
    branches['cr/studio/binding/0'] = new Map([['studio.json', JSON.stringify({ baseUrl: 'https://studio.contentrain.io', projectId: 'someone-else' })]])
    await bind()
    expect(commits).toHaveLength(1)
    expect(commits[0]!.branch).toBe('cr/studio/binding/1')
  })

  it('a write that fails is recorded as failed and never thrown; the next try writes once', async () => {
    failWrite = true
    vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(await bind()).toEqual({ state: 'failed', attempts: 1, code: 'github_unavailable' })
    // The first failure waits 30 minutes before the sweep tries again.
    expect(recorded()).toMatchObject({ state: 'failed', detail: { code: 'github_unavailable' }, attempts: 1 })
    expect((recorded() as unknown as { nextAt: Date }).nextAt.getTime() - Date.now()).toBeGreaterThan(29 * 60_000)
    failWrite = false
    expect(await bind()).toEqual({ state: 'written' })
    expect(commits).toHaveLength(1)
  })

  it('the retry schedule doubles from 30 minutes and stops at the cap', async () => {
    const { siteBindingNextAt, SITE_BINDING_MAX_ATTEMPTS } = await import('../../server/utils/migrate-site-binding')
    const now = new Date('2026-10-10T00:00:00Z')
    const after = (n: number) => (siteBindingNextAt(n, now)!.getTime() - now.getTime()) / 60_000
    expect([1, 2, 3, 4].map(after)).toEqual([30, 60, 120, 240])
    expect(siteBindingNextAt(SITE_BINDING_MAX_ATTEMPTS, now)).toBeNull()
  })
})

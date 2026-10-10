import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * A "Migrate with Studio" order whose account already runs a plan that covers it, through the three real handlers in the
 * order they run: the provision (`provisionMigrateBundle` → `provisionCovered`, before delivery: the grant is redeemed on
 * the account's workspace and knows no repository yet), the post-delivery claim (`POST /api/migrate/claim`: the signed
 * claim carries the delivered repository), and the claim screen's connect (`POST …/connect-project`, which binds the
 * site's forms: studio.json, #452). One grant store is shared by all three, with the semantics of the postgres provider
 * (`claimMigrateGrant` hands an existing order's row back whatever its state; `setMigrateGrantRepo` writes only while the
 * repository is unknown) — the contract suite pins those on a real database (`migrate-grants.contract.test.ts`).
 *
 * The question it answers (migrate#758): a covered grant is redeemed BEFORE delivery, so does the claim still give it
 * its repository, and does connect-project then let it through (`!owner || !name` refuses) and bind the site?
 */

function createErrorLike(input: { statusCode: number, message: string, data?: unknown }) {
  return Object.assign(new Error(input.message), input)
}

const resolveMigrateAccountState = vi.fn()
const coveringWorkspace = vi.fn()
vi.mock('../../server/utils/migrate-account-state', () => ({
  resolveMigrateAccountState: (...args: unknown[]) => resolveMigrateAccountState(...args),
  coveringWorkspace: (...args: unknown[]) => coveringWorkspace(...args),
}))
vi.mock('../../server/utils/deployment', () => ({ resolveDeployment: () => ({ planSource: 'subscription' }) }))
const verifyMigrateClaim = vi.fn()
vi.mock('../../server/utils/migrate-claim', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../server/utils/migrate-claim')>()
  return { ...actual, verifyMigrateClaim: (...args: unknown[]) => verifyMigrateClaim(...args) }
})
const git = { detectFramework: vi.fn(), getDefaultBranch: vi.fn() }
const gitApp = { resolveRepository: vi.fn(), getInstallationDetails: vi.fn() }
const gitFor = vi.fn()
vi.mock('../../server/utils/providers', () => ({
  useGitAppProvider: () => gitApp,
  useGitProvider: (input: unknown) => {
    gitFor(input)
    return git
  },
}))
vi.mock('../../server/utils/ensure-content-branch', () => ({ unmergedMigrationBranch: async () => null }))
vi.mock('../../server/utils/migration-handoff', () => ({ syncMigrationHandoff: () => Promise.resolve() }))
const ensureMigrateSiteBinding = vi.fn()
vi.mock('../../server/utils/migrate-site-binding', async importOriginal => ({
  ...(await importOriginal<typeof import('../../server/utils/migrate-site-binding')>()),
  ensureMigrateSiteBinding: (...a: unknown[]) => ensureMigrateSiteBinding(...a),
}))
vi.mock('../../server/utils/media-url', () => ({ publicMediaBase: (id: string) => `https://studio.example.com/api/cdn/v1/${id}` }))

const NOW = new Date('2026-10-10T12:00:00Z')
const nowSec = Math.floor(NOW.getTime() / 1000)
const USER = { id: 'user-1', email: 'owner@example.com' }
const WORKSPACE = { id: 'ws-paid', slug: 'agency', name: 'Agency', type: 'secondary', plan: 'pro', overage_settings: {}, github_installation_id: 4242 }

/** The provision claim Migrate signs for a covered order (v2): the plan's fee only, no repository (none exists yet). */
const provisionClaim = {
  iss: 'contentrain-migrate', aud: 'contentrain-studio', v: 2, jti: 'jti-provision', iat: nowSec, exp: nowSec + 300,
  sub: 'ten_1', order_id: 'ord_covered', email: USER.email, plan: 'starter', plan_evidence: [], github_user_id: '4242',
  email_verified: true, return_url: 'https://migrate.contentrain.io/d/abc/payment?order=ord_covered',
  billing: { migrate_fee_cents: 49_000, quoted_total_cents: 49_000, currency: 'usd' }, origin: 'https://old-blog.example',
}
/** The post-delivery claim (the "Continue to Studio" link): now with the delivered repository. */
const deliveryClaim = {
  claim: { v: 1, order_id: 'ord_covered', email: USER.email, plan: 'starter', trial_days: 60, repo: { provider: 'github', owner: 'ABB65', name: 'covered-site' }, origin: 'https://old-blog.example' },
  jti: 'jti-delivery',
  subject: 'ten_1',
  warnings: [],
}

describe('a covered bundle grant: provision → claim → connect-project → site binding', () => {
  let grants: Map<string, Record<string, unknown>>
  let projects: Array<Record<string, unknown>>
  let db: Record<string, ReturnType<typeof vi.fn>>

  beforeEach(() => {
    vi.resetModules()
    grants = new Map()
    projects = []
    const byOrder = (orderId: string) => [...grants.values()].find(g => g.order_id === orderId)
    db = {
      // Insert once per order; a second claim hands the existing row back as it is (no state filter), like the provider.
      claimMigrateGrant: vi.fn(async (input: Record<string, unknown>) => {
        const existing = byOrder(String(input.orderId))
        if (existing) return { grant: { ...existing }, created: false }
        const row = {
          id: 'grant-covered', order_id: input.orderId, claim_jti: input.claimJti, user_id: input.userId, plan: input.plan,
          trial_days: input.trialDays ?? null, repo_owner: input.repoOwner ?? null, repo_name: input.repoName ?? null,
          email: input.email, origin: input.origin ?? null, kind: input.kind ?? 'trial', workspace_id: null, bound_at: null,
          redeemed_at: null, revoked_at: null, checkout_url: null, checkout_expires_at: null, amount_cents: null,
        }
        grants.set(row.id, row)
        return { grant: { ...row }, created: true }
      }),
      bindMigrateGrantWorkspace: vi.fn(async (id: string, workspaceId: string) => {
        const g = grants.get(id)!
        if (g.workspace_id && g.workspace_id !== workspaceId) return null
        Object.assign(g, { workspace_id: workspaceId, bound_at: g.bound_at ?? NOW.toISOString() })
        return { ...g }
      }),
      markMigrateGrantRedeemed: vi.fn(async (id: string) => {
        Object.assign(grants.get(id)!, { redeemed_at: NOW.toISOString() })
      }),
      // Only while the repository is unknown, like the provider's `WHERE repo_owner IS NULL AND repo_name IS NULL`.
      setMigrateGrantRepo: vi.fn(async (id: string, repo: { owner: string, name: string }) => {
        const g = grants.get(id)
        if (!g) return null
        if (g.repo_owner === null && g.repo_name === null) Object.assign(g, { repo_owner: repo.owner, repo_name: repo.name })
        return { ...g }
      }),
      getMigrateGrantForUser: vi.fn(async (id: string, userId: string) => {
        const g = grants.get(id)
        return g && g.user_id === userId ? { ...g } : null
      }),
      getMigrateCommentsExportState: vi.fn(async () => null),
      updateMigrateGrantRepo: vi.fn(async () => undefined),
      getWorkspaceById: vi.fn(async () => WORKSPACE),
      getWorkspaceForUser: vi.fn(async () => WORKSPACE),
      listWorkspaceProjects: vi.fn(async () => projects),
      getActivePaymentAccount: vi.fn(async () => ({ subscription_id: 'sub_own', subscription_status: 'active', plan: 'pro', current_period_end: '2099-01-01T00:00:00Z', trial_ends_at: null, cancel_at_period_end: false, grace_period_ends_at: null, plugin_metadata: {} })),
      checkDuplicateProject: vi.fn(async () => false),
      createProject: vi.fn(async (_t: string, input: Record<string, unknown>) => {
        const row = { id: 'proj-covered', ...input }
        projects.push(row)
        return row
      }),
      getProjectById: vi.fn(async () => ({ id: 'proj-covered', content_root: '', default_branch: 'main' })),
    }
    resolveMigrateAccountState.mockReset().mockResolvedValue({ state: 'covers', plan: 'pro', year1_cents: 0, current_plan: 'pro' })
    coveringWorkspace.mockReset().mockResolvedValue({ id: WORKSPACE.id, slug: WORKSPACE.slug })
    verifyMigrateClaim.mockReset().mockResolvedValue(deliveryClaim)
    git.detectFramework.mockReset().mockResolvedValue({ stack: 'astro', hasContentDir: true, hasI18n: false, suggestedContentPaths: {} })
    git.getDefaultBranch.mockReset().mockResolvedValue('main')
    gitApp.resolveRepository.mockReset().mockResolvedValue({ id: 7, fullName: 'ABB65/covered-site' })
    gitApp.getInstallationDetails.mockReset().mockResolvedValue({ account: { login: 'ABB65' } })
    gitFor.mockReset()
    ensureMigrateSiteBinding.mockReset().mockResolvedValue({ state: 'written' })

    vi.stubGlobal('defineEventHandler', (h: unknown) => h)
    vi.stubGlobal('createError', createErrorLike)
    vi.stubGlobal('errorMessage', (key: string) => key)
    vi.stubGlobal('requireAuth', () => ({ user: USER, accessToken: 't' }))
    vi.stubGlobal('readBody', async () => ({ token: 'signed.delivery.claim' }))
    vi.stubGlobal('getRouterParam', () => 'grant-covered')
    vi.stubGlobal('checkRateLimit', async () => ({ allowed: true, remaining: 1, retryAfterMs: 0 }))
    vi.stubGlobal('useRuntimeConfig', () => ({
      public: { siteUrl: 'https://studio.example.com' },
      migrate: { origins: 'https://migrate.contentrain.io', claimPublicKey: '-----BEGIN PUBLIC KEY-----\\nMCow\\n-----END PUBLIC KEY-----' },
    }))
    vi.stubGlobal('useDatabaseProvider', () => db)
    vi.stubGlobal('useAuthProvider', () => ({ ensureUserForProviderAccount: async () => USER }))
    vi.stubGlobal('usePaymentProvider', () => null)
    vi.stubGlobal('useGitProvider', (input: unknown) => {
      gitFor(input)
      return git
    })
    vi.stubGlobal('ensureContentBranch', vi.fn().mockResolvedValue(undefined))
    vi.stubGlobal('normalizeContentRoot', (v: string) => v)
  })

  afterEach(() => vi.unstubAllGlobals())

  it('the redeemed grant takes its repository from the post-delivery claim, connect-project lets it through and binds the site', async () => {
    // 1. Before delivery: covered — redeemed on the account's workspace, no checkout, no repository yet.
    const { provisionMigrateBundle } = await import('../../server/utils/migrate-provision')
    expect(await provisionMigrateBundle(provisionClaim as never, NOW)).toEqual({ grant_id: 'grant-covered', state: 'redeemed', plan: 'starter', workspace_slug: 'agency' })
    expect(grants.get('grant-covered')).toMatchObject({ kind: 'bundle', workspace_id: 'ws-paid', repo_owner: null, repo_name: null, checkout_url: null })
    expect(grants.get('grant-covered')!.redeemed_at).not.toBeNull()

    // 2. After delivery: the claim on the same order finds the redeemed grant and gives it the delivered repository.
    const claim = (await import('../../server/api/migrate/claim.post')).default as unknown as (e: unknown) => Promise<{ grant: Record<string, unknown> }>
    const claimed = await claim({})
    expect(claimed.grant).toMatchObject({ id: 'grant-covered', state: 'redeemed', repo: { owner: 'ABB65', name: 'covered-site' } })
    expect(grants.get('grant-covered')).toMatchObject({ repo_owner: 'ABB65', repo_name: 'covered-site', redeemed_at: NOW.toISOString(), workspace_id: 'ws-paid' })

    // 3. The claim screen's connect: not refused (`grant_not_ready`), the project is created and the site is bound.
    const connect = (await import('../../server/api/migrate/grants/[grantId]/connect-project.post')).default as unknown as (e: unknown) => Promise<unknown>
    expect(await connect({})).toEqual({ projectId: 'proj-covered', workspaceSlug: 'agency', created: true, siteBinding: { state: 'written' } })
    expect(db.createProject).toHaveBeenCalledWith('t', expect.objectContaining({ workspace_id: 'ws-paid', repo_full_name: 'ABB65/covered-site' }))
    expect(ensureMigrateSiteBinding).toHaveBeenCalledWith(expect.objectContaining({ grantId: 'grant-covered', projectId: 'proj-covered', defaultBranch: 'main', studio: expect.objectContaining({ baseUrl: 'https://studio.example.com' }) }))
    // The write goes to the delivered repository, through the workspace's own installation.
    expect(gitFor).toHaveBeenLastCalledWith({ installationId: 4242, owner: 'ABB65', repo: 'covered-site' })
  })

  it('a second claim of the same order never moves the repository the first one wrote', async () => {
    const { provisionMigrateBundle } = await import('../../server/utils/migrate-provision')
    await provisionMigrateBundle(provisionClaim as never, NOW)
    const claim = (await import('../../server/api/migrate/claim.post')).default as unknown as (e: unknown) => Promise<unknown>
    await claim({})
    verifyMigrateClaim.mockResolvedValue({ ...deliveryClaim, jti: 'jti-again', claim: { ...deliveryClaim.claim, repo: { provider: 'github', owner: 'ABB65', name: 'other' } } })
    await claim({})
    expect(grants.get('grant-covered')).toMatchObject({ repo_owner: 'ABB65', repo_name: 'covered-site' })
  })
})

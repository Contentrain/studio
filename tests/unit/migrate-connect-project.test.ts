import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

function createErrorLike(input: { statusCode: number, message: string, data?: unknown }) {
  return Object.assign(new Error(input.message), input)
}

vi.mock('../../server/utils/deployment', () => ({ resolveDeployment: () => ({ planSource: 'subscription' }) }))

const git = {
  detectFramework: vi.fn(),
  getDefaultBranch: vi.fn(),
}
const gitApp = { resolveRepository: vi.fn(), getInstallationDetails: vi.fn() }
vi.mock('../../server/utils/providers', () => ({
  useGitAppProvider: () => gitApp,
  useGitProvider: () => git,
}))
const unmergedMigrationBranch = vi.fn()
vi.mock('../../server/utils/ensure-content-branch', () => ({ unmergedMigrationBranch: (...a: unknown[]) => unmergedMigrationBranch(...a) }))
vi.mock('../../server/utils/migration-handoff', () => ({ syncMigrationHandoff: () => Promise.resolve() }))
const ensureMigrateSiteBinding = vi.fn()
vi.mock('../../server/utils/migrate-site-binding', () => ({ ensureMigrateSiteBinding: (...a: unknown[]) => ensureMigrateSiteBinding(...a) }))
vi.mock('../../server/utils/media-url', () => ({ publicMediaBase: (id: string) => `https://studio.example/api/cdn/v1/${id}` }))

const grantRow = {
  id: 'grant-1', order_id: 'ord_123', user_id: 'user-1', kind: 'bundle', plan: 'pro', trial_days: null,
  repo_owner: 'ABB65', repo_name: 'formchickens', workspace_id: 'ws-1', bound_at: '2026-10-01T10:00:00Z',
  redeemed_at: '2026-10-01T10:00:00Z', revoked_at: null,
}
const account = (over: Record<string, unknown> = {}) => ({
  subscription_id: 'sub_1', subscription_status: 'active', plan: 'pro', current_period_end: '2099-01-01T00:00:00Z',
  trial_ends_at: null, cancel_at_period_end: false, grace_period_ends_at: null, plugin_metadata: {}, ...over,
})

describe('POST /api/migrate/grants/:grantId/connect-project', () => {
  let db: Record<string, ReturnType<typeof vi.fn>>
  const route = async () => ((await import('../../server/api/migrate/grants/[grantId]/connect-project.post')).default as (e: unknown) => Promise<unknown>)({})

  beforeEach(() => {
    vi.resetModules()
    git.detectFramework.mockReset().mockResolvedValue({ stack: 'astro', hasContentDir: true, hasI18n: false, suggestedContentPaths: {} })
    git.getDefaultBranch.mockReset().mockResolvedValue('main')
    gitApp.resolveRepository.mockReset().mockResolvedValue({ id: 1, fullName: 'ABB65/formchickens' })
    gitApp.getInstallationDetails.mockReset().mockResolvedValue({ account: { login: 'ABB65' } })
    unmergedMigrationBranch.mockReset().mockResolvedValue(null)
    ensureMigrateSiteBinding.mockReset().mockResolvedValue({ state: 'written' })
    db = {
      getMigrateGrantForUser: vi.fn().mockResolvedValue(grantRow),
      getWorkspaceForUser: vi.fn().mockResolvedValue({ id: 'ws-1', slug: 'acme', type: 'secondary', plan: 'pro', overage_settings: {}, github_installation_id: 4242 }),
      getWorkspaceById: vi.fn().mockResolvedValue({ id: 'ws-1', github_installation_id: 4242 }),
      listWorkspaceProjects: vi.fn().mockResolvedValue([]),
      getActivePaymentAccount: vi.fn().mockResolvedValue(account()),
      checkDuplicateProject: vi.fn().mockResolvedValue(false),
      createProject: vi.fn().mockResolvedValue({ id: 'proj-new' }),
      updateMigrateGrantRepo: vi.fn().mockResolvedValue(undefined),
      getProjectById: vi.fn().mockResolvedValue({ id: 'proj-new', content_root: '', default_branch: 'main' }),
    }
    vi.stubGlobal('defineEventHandler', (h: unknown) => h)
    vi.stubGlobal('createError', createErrorLike)
    vi.stubGlobal('errorMessage', (key: string) => key)
    vi.stubGlobal('requireAuth', () => ({ user: { id: 'user-1' }, accessToken: 't' }))
    vi.stubGlobal('getRouterParam', () => 'grant-1')
    vi.stubGlobal('useRuntimeConfig', () => ({ migrate: { claimPublicKey: '-----BEGIN PUBLIC KEY-----\\nMCow\\n-----END PUBLIC KEY-----' }, public: { siteUrl: 'https://studio.example' } }))
    vi.stubGlobal('useDatabaseProvider', () => db)
    vi.stubGlobal('useGitProvider', () => git)
    vi.stubGlobal('ensureContentBranch', vi.fn().mockResolvedValue(undefined))
    vi.stubGlobal('normalizeContentRoot', (v: string) => v)
  })

  afterEach(() => vi.unstubAllGlobals())

  it('makes the delivered repository a project, with what was detected, and says where it is', async () => {
    expect(await route()).toEqual({ projectId: 'proj-new', workspaceSlug: 'acme', created: true, siteBinding: { state: 'written' } })
    expect(db.createProject).toHaveBeenCalledWith('t', expect.objectContaining({
      workspace_id: 'ws-1', repo_full_name: 'ABB65/formchickens', default_branch: 'main', detected_stack: 'astro', status: 'active',
    }))
  })

  it('binds the new project\'s site: studio.json for THIS project on its default branch, Studio\'s origin and media base, the grant', async () => {
    await route()
    expect(ensureMigrateSiteBinding).toHaveBeenCalledTimes(1)
    expect(ensureMigrateSiteBinding.mock.calls[0]![0]).toMatchObject({
      grantId: 'grant-1', projectId: 'proj-new', contentRoot: '', defaultBranch: 'main', plan: 'pro',
      studio: { baseUrl: 'https://studio.example', mediaBaseUrl: 'https://studio.example/api/cdn/v1/proj-new' },
    })
  })

  it('the claim screen\'s retry is the same call: an existing project is bound again (idempotent), and says how it went', async () => {
    db.listWorkspaceProjects.mockResolvedValue([{ id: 'proj-old', repo_full_name: 'ABB65/formchickens' }])
    db.getProjectById.mockResolvedValue({ id: 'proj-old', content_root: '', default_branch: 'trunk' })
    ensureMigrateSiteBinding.mockResolvedValue({ state: 'pr_open', prUrl: 'https://github.com/ABB65/formchickens/pull/3' })
    expect(await route()).toMatchObject({ projectId: 'proj-old', created: false, siteBinding: { state: 'pr_open', prUrl: 'https://github.com/ABB65/formchickens/pull/3' } })
    expect(await route()).toMatchObject({ projectId: 'proj-old', created: false })
    expect(ensureMigrateSiteBinding).toHaveBeenCalledTimes(2)
    expect(ensureMigrateSiteBinding.mock.calls[1]![0]).toMatchObject({ projectId: 'proj-old', defaultBranch: 'trunk' })
    expect(db.createProject).not.toHaveBeenCalled()
  })

  it('a binding that did not go through never fails the connect: the project is the answer, the state says why', async () => {
    ensureMigrateSiteBinding.mockResolvedValue({ state: 'failed' })
    expect(await route()).toEqual({ projectId: 'proj-new', workspaceSlug: 'acme', created: true, siteBinding: { state: 'failed' } })
  })

  it('a second click finds the project already there: the same answer, nothing created', async () => {
    db.listWorkspaceProjects.mockResolvedValue([{ id: 'proj-old', repo_full_name: 'abb65/FormChickens' }])
    expect(await route()).toEqual({ projectId: 'proj-old', workspaceSlug: 'acme', created: false, siteBinding: { state: 'written' } })
    expect(db.createProject).not.toHaveBeenCalled()
  })

  it('a project made between the check and the create (409) is not hidden: already_connected', async () => {
    db.checkDuplicateProject.mockResolvedValue(true)
    await expect(route()).rejects.toMatchObject({ statusCode: 409, data: { code: 'already_connected' } })
  })

  it.each([
    ['no running plan (locked: canceled and past its period)', { subscription_status: 'canceled', current_period_end: '2020-01-01T00:00:00Z' }],
    ['no subscription at all', null],
  ])('plan_locked: %s', async (_name, acct) => {
    db.getActivePaymentAccount.mockResolvedValue(acct ? account(acct) : null)
    await expect(route()).rejects.toMatchObject({ statusCode: 409, message: 'migrate.connect_plan_locked', data: { code: 'plan_locked' } })
    expect(db.createProject).not.toHaveBeenCalled()
  })

  it('a plan that is ending or past_due within grace still connects', async () => {
    db.getActivePaymentAccount.mockResolvedValue(account({ subscription_status: 'canceled' }))
    await expect(route()).resolves.toMatchObject({ created: true })
    db.getActivePaymentAccount.mockResolvedValue(account({ subscription_status: 'past_due', grace_period_ends_at: '2099-01-01T00:00:00Z' }))
    await expect(route()).resolves.toMatchObject({ created: true })
  })

  it('no_installation: the workspace has no Studio GitHub App yet', async () => {
    db.getWorkspaceForUser.mockResolvedValue({ id: 'ws-1', slug: 'acme', type: 'secondary', plan: 'pro', overage_settings: {}, github_installation_id: null })
    await expect(route()).rejects.toMatchObject({ statusCode: 409, data: { code: 'no_installation' } })
  })

  it('repo_not_accessible: the app cannot see the repository, with the installation\'s settings page', async () => {
    gitApp.resolveRepository.mockResolvedValue(null)
    await expect(route()).rejects.toMatchObject({
      statusCode: 409,
      data: { code: 'repo_not_accessible', settingsUrl: 'https://github.com/settings/installations/4242' },
    })
    expect(db.createProject).not.toHaveBeenCalled()
  })

  it('repo_other_account: the repository is in another GitHub account than the workspace\'s installation: no "give access" advice', async () => {
    db.getMigrateGrantForUser.mockResolvedValue({ ...grantRow, repo_owner: 'Lanista-Software' })
    gitApp.resolveRepository.mockResolvedValue(null)
    const error = await route().catch(e => e)
    expect(error).toMatchObject({
      statusCode: 409,
      message: 'migrate.connect_repo_other_account',
      data: { code: 'repo_other_account', repoOwner: 'Lanista-Software', workspaceAccount: 'ABB65' },
    })
    expect(error.data.settingsUrl).toBeUndefined()
    expect(db.createProject).not.toHaveBeenCalled()
  })

  it('the same account written in another case is not another account: repo_not_accessible', async () => {
    gitApp.resolveRepository.mockResolvedValue(null)
    gitApp.getInstallationDetails.mockResolvedValue({ account: { login: 'abb65' } })
    await expect(route()).rejects.toMatchObject({ data: { code: 'repo_not_accessible' } })
  })

  it('an installation GitHub will not describe falls back to repo_not_accessible', async () => {
    db.getMigrateGrantForUser.mockResolvedValue({ ...grantRow, repo_owner: 'Lanista-Software' })
    gitApp.resolveRepository.mockResolvedValue(null)
    gitApp.getInstallationDetails.mockRejectedValue(new Error('boom'))
    await expect(route()).rejects.toMatchObject({ data: { code: 'repo_not_accessible' } })
  })

  it('a transferred repository connects under its new name and the grant follows it', async () => {
    db.getMigrateGrantForUser.mockResolvedValue({ ...grantRow, repo_owner: 'Lanista-Software' })
    gitApp.resolveRepository.mockResolvedValue({ id: 7, fullName: 'ABB65/formchickens' })
    expect(await route()).toEqual({ projectId: 'proj-new', workspaceSlug: 'acme', created: true, siteBinding: { state: 'written' } })
    expect(db.updateMigrateGrantRepo).toHaveBeenCalledWith('grant-1', { owner: 'ABB65', name: 'formchickens' })
    expect(db.createProject).toHaveBeenCalledWith('t', expect.objectContaining({ repo_full_name: 'ABB65/formchickens' }))
  })

  it('a transferred repository that is already a project there is the answer, with the grant updated', async () => {
    db.getMigrateGrantForUser.mockResolvedValue({ ...grantRow, repo_owner: 'Lanista-Software' })
    gitApp.resolveRepository.mockResolvedValue({ id: 7, fullName: 'ABB65/formchickens' })
    db.listWorkspaceProjects.mockResolvedValue([{ id: 'proj-old', repo_full_name: 'ABB65/formchickens' }])
    expect(await route()).toEqual({ projectId: 'proj-old', workspaceSlug: 'acme', created: false, siteBinding: { state: 'written' } })
    expect(db.updateMigrateGrantRepo).toHaveBeenCalled()
  })

  it('a repository under the grant\'s own name rewrites nothing', async () => {
    await route()
    expect(db.updateMigrateGrantRepo).not.toHaveBeenCalled()
  })

  it('migration_not_merged: the delivery waits on its branch', async () => {
    unmergedMigrationBranch.mockResolvedValue('migrate/delivery-1')
    await expect(route()).rejects.toMatchObject({ statusCode: 409, data: { code: 'migration_not_merged', branch: 'migrate/delivery-1' } })
    expect(db.createProject).not.toHaveBeenCalled()
  })

  it.each([
    ['a grant that is not a bundle', { kind: 'trial' }],
    ['a bundle not yet in use', { redeemed_at: null }],
    ['a grant without a workspace', { workspace_id: null }],
    ['a grant that does not know its repository', { repo_owner: null, repo_name: null }],
  ])('grant_not_ready: %s', async (_name, over) => {
    db.getMigrateGrantForUser.mockResolvedValue({ ...grantRow, ...over })
    await expect(route()).rejects.toMatchObject({ statusCode: 409, data: { code: 'grant_not_ready' } })
  })

  it('a withdrawn grant, an unknown grant and a caller who does not administer the workspace', async () => {
    db.getMigrateGrantForUser.mockResolvedValue({ ...grantRow, revoked_at: '2026-10-02T00:00:00Z' })
    await expect(route()).rejects.toMatchObject({ statusCode: 409, data: { code: 'grant_revoked' } })
    db.getMigrateGrantForUser.mockResolvedValue(null)
    await expect(route()).rejects.toMatchObject({ statusCode: 404, data: { code: 'grant_not_found' } })
    db.getMigrateGrantForUser.mockResolvedValue(grantRow)
    db.getWorkspaceForUser.mockResolvedValue(null)
    await expect(route()).rejects.toMatchObject({ statusCode: 403 })
  })

  it('is off without Migrate\'s key', async () => {
    vi.stubGlobal('useRuntimeConfig', () => ({ migrate: { claimPublicKey: '' } }))
    await expect(route()).rejects.toMatchObject({ statusCode: 404, data: { code: 'unavailable' } })
  })
})

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const runMediaRehost = vi.fn()

vi.mock('~~/server/utils/media-rehost', async importOriginal => ({
  ...await importOriginal<typeof import('../../server/utils/media-rehost')>(),
  runMediaRehost,
}))

function createErrorLike(input: { statusCode: number, message: string, data?: unknown }) {
  return Object.assign(new Error(input.message), input)
}

async function loadHandler() {
  return (await import('../../server/api/workspaces/[workspaceId]/projects/[projectId]/media/rehost.post')).default
}

const COUNTS = {
  from: 'https://staging.example.com/api/cdn/v1/old-proj',
  to: 'https://studio.example.com/api/cdn/v1/project-1',
  filesScanned: 3,
  filesChanged: 2,
  references: 5,
  mediaPaths: 3,
  missing: [] as string[],
  copy: { requested: false, toCopy: 0, copied: 0, failed: [] as string[] },
  library: { toAdd: 0, existing: 0, added: 0 },
}

function stubRoute(opts: { role: string, body: unknown }) {
  vi.stubGlobal('getRouterParam', vi.fn((_: unknown, key: string) => (key === 'workspaceId' ? 'workspace-1' : key === 'projectId' ? 'project-1' : undefined)))
  vi.stubGlobal('resolveAgentPermissions', vi.fn().mockResolvedValue({ workspaceRole: opts.role, availableTools: ['save_content'] }))
  vi.stubGlobal('readBody', vi.fn().mockResolvedValue(opts.body))
}

const VALID_BODY = { from: { siteUrl: 'https://staging.example.com', projectId: 'old-proj' } }

describe('media rehost route', () => {
  const mergeBranch = vi.fn()

  beforeEach(() => {
    vi.resetModules()
    runMediaRehost.mockReset()
    vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
    vi.stubGlobal('createError', createErrorLike)
    vi.stubGlobal('errorMessage', vi.fn((key: string) => key))
    vi.stubGlobal('requireAuth', vi.fn().mockReturnValue({ user: { id: 'user-1', email: 'owner@example.com' }, accessToken: 'token-1' }))
    vi.stubGlobal('useRuntimeConfig', () => ({ public: { siteUrl: 'https://studio.example.com' } }))
    vi.stubGlobal('useCDNProvider', vi.fn().mockReturnValue({}))
    vi.stubGlobal('checkRateLimit', vi.fn().mockResolvedValue({ allowed: true }))
    vi.stubGlobal('resolveProjectContext', vi.fn().mockResolvedValue({ git: {}, contentRoot: '' }))
    vi.stubGlobal('createContentEngine', vi.fn().mockReturnValue({ ensureContentBranch: vi.fn(), mergeBranch }))
    vi.stubGlobal('invalidateBrainCache', vi.fn())
    vi.stubGlobal('useDatabaseProvider', vi.fn().mockReturnValue({}))
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it.each(['member', 'editor', null])('refuses workspace role %s', async (role) => {
    stubRoute({ role: role as string, body: VALID_BODY })
    const handler = await loadHandler()
    await expect(handler({} as never)).rejects.toMatchObject({ statusCode: 403, message: 'project.settings_owner_only' })
    expect(runMediaRehost).not.toHaveBeenCalled()
  })

  it('rejects an unusable source before touching the repo', async () => {
    stubRoute({ role: 'owner', body: { from: { siteUrl: 'nope', projectId: 'old-proj' } } })
    const handler = await loadHandler()
    await expect(handler({} as never)).rejects.toMatchObject({ statusCode: 400, message: 'media.rehost_invalid_source' })
    expect(resolveProjectContext).not.toHaveBeenCalled()
  })

  it('is a dry run unless dryRun: false is sent', async () => {
    stubRoute({ role: 'admin', body: VALID_BODY })
    runMediaRehost.mockResolvedValue({ status: 'dry_run', counts: COUNTS })
    const handler = await loadHandler()

    await expect(handler({} as never)).resolves.toEqual({ status: 'dry_run', counts: COUNTS })
    expect(runMediaRehost).toHaveBeenCalledWith(expect.objectContaining({
      dryRun: true,
      copyAssets: false,
      projectId: 'project-1',
      siteUrl: 'https://studio.example.com',
      from: { siteUrl: 'https://staging.example.com', projectId: 'old-proj' },
    }))
  })

  it('answers 409 with the missing list and commits nothing', async () => {
    stubRoute({ role: 'owner', body: { ...VALID_BODY, dryRun: false } })
    const counts = { ...COUNTS, missing: ['media/original/b.png'] }
    runMediaRehost.mockResolvedValue({ status: 'missing_assets', counts })
    const handler = await loadHandler()

    await expect(handler({} as never)).rejects.toMatchObject({ statusCode: 409, message: 'media.rehost_missing_assets', data: counts })
    expect(invalidateBrainCache).not.toHaveBeenCalled()
  })

  it('returns the commit and invalidates the brain cache once landed', async () => {
    stubRoute({ role: 'owner', body: { ...VALID_BODY, dryRun: false } })
    const committed = { status: 'committed', counts: COUNTS, branch: 'cr/media/rehost/1-ab', commitSha: 'sha', merged: true, pullRequestUrl: null }
    runMediaRehost.mockResolvedValue(committed)
    const handler = await loadHandler()

    await expect(handler({} as never)).resolves.toEqual(committed)
    expect(invalidateBrainCache).toHaveBeenCalledWith('project-1')
  })

  describe('copyAssets source access', () => {
    const SOURCE_ID = '0b6f3c1e-9d2a-4f5b-8c7d-1e2f3a4b5c6d'
    const COPY_BODY = { from: { siteUrl: 'https://studio.example.com', projectId: SOURCE_ID }, copyAssets: true }

    function stubSource(source: Record<string, unknown> | null, requireWorkspaceRole: ReturnType<typeof vi.fn>) {
      const db = { getProjectById: vi.fn().mockResolvedValue(source), requireWorkspaceRole }
      vi.stubGlobal('useDatabaseProvider', vi.fn().mockReturnValue(db))
      return db
    }

    const forbidden = () => vi.fn().mockRejectedValue(createErrorLike({ statusCode: 403, message: 'members.requires_role' }))

    it.each([true, false])('refuses a project in a workspace the caller does not own or admin (dryRun %s), leaking no counts', async (dryRun) => {
      stubRoute({ role: 'owner', body: { ...COPY_BODY, dryRun } })
      const db = stubSource({ id: SOURCE_ID, workspace_id: 'other-ws' }, forbidden())
      const handler = await loadHandler()

      const error = await handler({} as never).catch((e: unknown) => e) as { statusCode: number, message: string, data?: unknown }
      expect(error).toMatchObject({ statusCode: 403, message: 'media.rehost_copy_source_forbidden' })
      expect(error.data).toBeUndefined()
      expect(db.requireWorkspaceRole).toHaveBeenCalledWith('token-1', 'user-1', 'other-ws', ['owner', 'admin'])
      expect(runMediaRehost).not.toHaveBeenCalled()
      expect(useCDNProvider).not.toHaveBeenCalled()
    })

    it('answers 400 for a source id that is not a uuid, before any lookup', async () => {
      stubRoute({ role: 'owner', body: { ...COPY_BODY, from: { ...COPY_BODY.from, projectId: 'old-proj' } } })
      const db = stubSource(null, vi.fn())
      const handler = await loadHandler()

      await expect(handler({} as never)).rejects.toMatchObject({ statusCode: 400, message: 'media.rehost_invalid_source' })
      expect(db.getProjectById).not.toHaveBeenCalled()
    })

    it('answers 404 for a project that does not exist', async () => {
      stubRoute({ role: 'owner', body: COPY_BODY })
      stubSource(null, vi.fn())
      const handler = await loadHandler()

      await expect(handler({} as never)).rejects.toMatchObject({ statusCode: 404, message: 'project.not_found' })
      expect(runMediaRehost).not.toHaveBeenCalled()
    })

    it('lets an owner/admin of the source workspace through', async () => {
      stubRoute({ role: 'owner', body: COPY_BODY })
      stubSource({ id: SOURCE_ID, workspace_id: 'workspace-1' }, vi.fn().mockResolvedValue('owner'))
      runMediaRehost.mockResolvedValue({ status: 'dry_run', counts: COUNTS })
      const handler = await loadHandler()

      await expect(handler({} as never)).resolves.toMatchObject({ status: 'dry_run' })
      expect(runMediaRehost).toHaveBeenCalledWith(expect.objectContaining({ copyAssets: true, workspaceId: 'workspace-1' }))
    })

    it.each([
      ['copy_failed', 'media.rehost_copy_failed'],
      ['library_failed', 'media.rehost_library_failed'],
    ])('maps %s to 409 with the counts', async (status, message) => {
      stubRoute({ role: 'owner', body: { ...COPY_BODY, dryRun: false } })
      stubSource({ id: SOURCE_ID, workspace_id: 'workspace-1' }, vi.fn().mockResolvedValue('owner'))
      runMediaRehost.mockResolvedValue({ status, counts: COUNTS })
      const handler = await loadHandler()

      await expect(handler({} as never)).rejects.toMatchObject({ statusCode: 409, message, data: COUNTS })
    })
  })

  it('refuses asset copy from another instance', async () => {
    stubRoute({ role: 'owner', body: { ...VALID_BODY, copyAssets: true } })
    const handler = await loadHandler()
    await expect(handler({} as never)).rejects.toMatchObject({ statusCode: 400, message: 'media.rehost_copy_other_instance' })
  })
})

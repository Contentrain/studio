import { COMMENTS_EXPORT_FORMAT } from '@contentrain/types'
import { describe, expect, it, vi } from 'vitest'
import type { MigrationHandoffSummary, StoredMigrationHandoff } from '../../server/utils/migration-handoff'
import { withTestServer } from '../helpers/http'

async function loadGet() {
  return (await import('../../server/api/workspaces/[workspaceId]/projects/[projectId]/migration/index.get')).default
}
async function loadSync() {
  return (await import('../../server/api/workspaces/[workspaceId]/projects/[projectId]/migration/sync.post')).default
}
async function loadImportComments() {
  return (await import('../../server/api/workspaces/[workspaceId]/projects/[projectId]/migration/import-comments.post')).default
}

const WORKSPACE = 'workspace-1'
const PROJECT = 'project-1'

const handoff = {
  version: 1,
  site_url: 'https://carriedils.com',
  generated_at: '2026-09-03T10:00:00.000Z',
  content_summary: { models: 7, entries: 95, locales: ['en'] },
  capabilities: [
    { key: 'comments', disposition: 'needs_runtime' },
    { key: 'seo', disposition: 'migrated_static' },
  ],
  comments: {
    total: 2,
    export: {
      format: COMMENTS_EXPORT_FORMAT,
      inline: {
        version: 1,
        format: COMMENTS_EXPORT_FORMAT,
        source: { kind: 'wxr' },
        generated_at: '2026-09-03T10:00:00.000Z',
        entries: { 10: { model_id: 'posts', entry_id: 'entry-1' } },
        threads_closed: [],
        comments: [
          { id: 1, post: 10, parent: null, author: 'Ada', date: '2020-05-01T10:00:00Z', content: 'Hi', approved: '1' },
          { id: 2, post: 10, parent: 1, author: 'Bob', date: '2020-05-02T10:00:00Z', content: 'Yo', approved: '0' },
        ],
      },
    },
  },
  offers: [{ capability: 'comments', provider: 'studio_managed' }],
}

function stubSession(role = 'owner') {
  vi.stubGlobal('getRouterParam', vi.fn((_: unknown, key: string) => {
    if (key === 'workspaceId') return WORKSPACE
    if (key === 'projectId') return PROJECT
    return undefined
  }))
  vi.stubGlobal('requireAuth', vi.fn().mockReturnValue({ user: { id: 'user-1', email: 'owner@acme.dev' }, accessToken: 'token-1' }))
  vi.stubGlobal('getWorkspacePlan', vi.fn().mockReturnValue('pro'))
  vi.stubGlobal('hasFeature', vi.fn().mockReturnValue(true))
  return {
    requireWorkspaceRole: vi.fn().mockResolvedValue(role),
    getProjectForWorkspace: vi.fn().mockResolvedValue({ id: PROJECT }),
    getProjectMember: vi.fn().mockResolvedValue({ id: 'pm-1', role: 'editor' }),
    getWorkspaceById: vi.fn().mockResolvedValue({ id: WORKSPACE, plan: 'pro', github_installation_id: 42 }),
  }
}

describe('migration handoff routes', () => {
  it('GET reports absence, then the summary + imported count once a handoff is stored', async () => {
    const base = stubSession('member')
    const getProjectById = vi.fn().mockResolvedValueOnce({ id: PROJECT, migration_handoff: null, migration_handoff_synced_at: null })
      .mockResolvedValueOnce({ id: PROJECT, migration_handoff: handoff, migration_handoff_synced_at: '2026-09-03T11:00:00.000Z' })
    const countCommentsByStatus = vi.fn().mockResolvedValue({ pending: 1, approved: 1, spam: 0, rejected: 0 })
    vi.stubGlobal('useDatabaseProvider', vi.fn().mockReturnValue({ ...base, getProjectById, countCommentsByStatus }))

    await withTestServer({
      routes: [{ path: '/api/workspaces/workspace-1/projects/project-1/migration', handler: await loadGet() }],
    }, async ({ request }) => {
      await expect((await request('/api/workspaces/workspace-1/projects/project-1/migration')).json()).resolves.toEqual({ present: false, syncedAt: null, summary: null, commentsImported: 0, claimExport: null })

      const second = await (await request('/api/workspaces/workspace-1/projects/project-1/migration')).json() as Record<string, unknown>
      expect(second.present).toBe(true)
      expect(second.commentsImported).toBe(2)
      expect(second.summary).toMatchObject({ siteUrl: 'https://carriedils.com', needsRuntime: ['comments'], comments: { total: 2, hasExport: true } })
      expect(base.getProjectMember).toHaveBeenCalledWith(PROJECT, 'user-1')
    })
  })

  it('sync reads a legacy root contentrain-handoff.json from the repo, enriches repository, and stores it', async () => {
    const base = stubSession()
    const setProjectMigrationHandoff = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('useDatabaseProvider', vi.fn().mockReturnValue({ ...base, setProjectMigrationHandoff }))
    const readFile = vi.fn(async (path: string, ref: string) => {
      if (path === 'contentrain-handoff.json' && ref === 'contentrain') return JSON.stringify(handoff)
      throw new Error('404')
    })
    vi.stubGlobal('resolveProjectContext', vi.fn().mockResolvedValue({
      git: { readFile },
      contentRoot: '',
      project: { repo_full_name: 'acme/site', default_branch: 'main' },
      workspace: { id: WORKSPACE },
    }))

    await withTestServer({
      routes: [{ path: '/api/workspaces/workspace-1/projects/project-1/migration/sync', handler: await loadSync() }],
    }, async ({ request }) => {
      const response = await request('/api/workspaces/workspace-1/projects/project-1/migration/sync', { method: 'POST' })
      expect(response.status).toBe(200)
      await expect(response.json()).resolves.toMatchObject({ found: true, source: { path: 'contentrain-handoff.json', ref: 'contentrain' } })
      expect(setProjectMigrationHandoff).toHaveBeenCalledWith(PROJECT, expect.objectContaining({
        site_url: 'https://carriedils.com',
        repository: { provider: 'github', owner: 'acme', name: 'site', default_branch: 'main' },
      }))
      // The comments export stays in the repository; the row keeps where to find it.
      const stored = setProjectMigrationHandoff.mock.calls[0]![1] as StoredMigrationHandoff
      expect(stored.comments).toEqual({ total: 2, export: { format: COMMENTS_EXPORT_FORMAT } })
      expect(stored.studio_intake).toMatchObject({
        source: { path: 'contentrain-handoff.json', ref: 'contentrain' },
        comments: { kind: 'inline', bytes: expect.any(Number) },
      })
    })
  })

  it('sync reads .contentrain/migrate/handoff.json first, and import-comments lands its inline export from there', async () => {
    const base = stubSession()
    const setProjectMigrationHandoff = vi.fn().mockResolvedValue(undefined)
    const importComments = vi.fn().mockResolvedValue({ inserted: 2, skippedExisting: 0, orphanCount: 0, orphanParents: [], maxDepth: 1, threadsClosed: 0 })
    const getProjectById = vi.fn()
    vi.stubGlobal('useDatabaseProvider', vi.fn().mockReturnValue({ ...base, setProjectMigrationHandoff, getProjectById, importComments }))
    // A repo migrated before the move still has the root file; the new one wins.
    const readFile = vi.fn(async (path: string, ref: string) => {
      if (path === 'site/.contentrain/migrate/handoff.json' && ref === 'contentrain') return JSON.stringify(handoff)
      if (path === 'contentrain-handoff.json') return JSON.stringify({ ...handoff, site_url: 'https://stale.example' })
      throw new Error('404')
    })
    vi.stubGlobal('resolveProjectContext', vi.fn().mockResolvedValue({
      git: { readFile },
      contentRoot: 'site',
      project: { repo_full_name: 'acme/site', default_branch: 'main' },
      workspace: { id: WORKSPACE },
    }))
    vi.stubGlobal('getOrBuildBrainCache', vi.fn().mockResolvedValue({ config: { locales: { default: 'en' } }, models: new Map() }))

    await withTestServer({
      routes: [
        { path: '/api/workspaces/workspace-1/projects/project-1/migration/sync', handler: await loadSync() },
        { path: '/api/workspaces/workspace-1/projects/project-1/migration/import-comments', handler: await loadImportComments() },
      ],
    }, async ({ request }) => {
      const synced = await request('/api/workspaces/workspace-1/projects/project-1/migration/sync', { method: 'POST' })
      expect(synced.status).toBe(200)
      await expect(synced.json()).resolves.toMatchObject({ found: true, source: { path: 'site/.contentrain/migrate/handoff.json', ref: 'contentrain' } })
      const stored = setProjectMigrationHandoff.mock.calls[0]![1] as StoredMigrationHandoff
      expect(stored.site_url).toBe('https://carriedils.com')
      expect(stored.comments).toEqual({ total: 2, export: { format: COMMENTS_EXPORT_FORMAT } })
      expect(stored.studio_intake?.source).toEqual({ path: 'site/.contentrain/migrate/handoff.json', ref: 'contentrain' })

      getProjectById.mockResolvedValue({ id: PROJECT, workspace_id: WORKSPACE, migration_handoff: stored })
      readFile.mockClear()
      const imported = await request('/api/workspaces/workspace-1/projects/project-1/migration/import-comments', { method: 'POST' })
      expect(imported.status).toBe(200)
      await expect(imported.json()).resolves.toMatchObject({ received: 2, inserted: 2 })
      expect(readFile.mock.calls).toEqual([['site/.contentrain/migrate/handoff.json', 'contentrain']])
      expect(importComments).toHaveBeenCalledTimes(1)
    })
  })

  it('sync refuses an oversized manifest with 413 naming the field, and stores nothing', async () => {
    const base = stubSession()
    const setProjectMigrationHandoff = vi.fn()
    const errorMessage = vi.fn((key: string) => key)
    vi.stubGlobal('errorMessage', errorMessage)
    vi.stubGlobal('useDatabaseProvider', vi.fn().mockReturnValue({ ...base, setProjectMigrationHandoff }))
    vi.stubGlobal('resolveProjectContext', vi.fn().mockResolvedValue({
      git: { readFile: vi.fn().mockResolvedValue(JSON.stringify({ ...handoff, notes: ['n'.repeat(2 * 1024 * 1024)] })) },
      contentRoot: '',
      project: { repo_full_name: 'acme/site', default_branch: 'main' },
      workspace: { id: WORKSPACE },
    }))

    await withTestServer({
      routes: [{ path: '/api/workspaces/workspace-1/projects/project-1/migration/sync', handler: await loadSync() }],
    }, async ({ request }) => {
      const response = await request('/api/workspaces/workspace-1/projects/project-1/migration/sync', { method: 'POST' })
      expect(response.status).toBe(413)
      expect(errorMessage).toHaveBeenCalledWith('migration.handoff_too_large', {
        detail: expect.stringMatching(/^manifest 2\.0 MB > 1\.0 MB; largest field: notes \(2\.0 MB\)$/),
      })
      expect(setProjectMigrationHandoff).not.toHaveBeenCalled()
    })
  })

  it('sync rejects a malformed handoff with 422 and stores nothing', async () => {
    const base = stubSession()
    const setProjectMigrationHandoff = vi.fn()
    vi.stubGlobal('useDatabaseProvider', vi.fn().mockReturnValue({ ...base, setProjectMigrationHandoff }))
    vi.stubGlobal('resolveProjectContext', vi.fn().mockResolvedValue({
      git: { readFile: vi.fn().mockResolvedValue(JSON.stringify({ version: 1, site_url: 'x', generated_at: 'nope', capabilities: [] })) },
      contentRoot: '',
      project: { repo_full_name: 'acme/site', default_branch: 'main' },
      workspace: { id: WORKSPACE },
    }))

    await withTestServer({
      routes: [{ path: '/api/workspaces/workspace-1/projects/project-1/migration/sync', handler: await loadSync() }],
    }, async ({ request }) => {
      const response = await request('/api/workspaces/workspace-1/projects/project-1/migration/sync', { method: 'POST' })
      expect(response.status).toBe(422)
      expect(setProjectMigrationHandoff).not.toHaveBeenCalled()
    })
  })

  it('import-comments lands the inline export through the shared import path', async () => {
    const base = stubSession()
    const importComments = vi.fn().mockResolvedValue({ inserted: 2, skippedExisting: 0, orphanCount: 0, orphanParents: [], maxDepth: 1, threadsClosed: 0 })
    vi.stubGlobal('useDatabaseProvider', vi.fn().mockReturnValue({
      ...base,
      getProjectById: vi.fn().mockResolvedValue({ id: PROJECT, workspace_id: WORKSPACE, migration_handoff: handoff }),
      importComments,
    }))
    vi.stubGlobal('resolveProjectContext', vi.fn().mockResolvedValue({ git: {}, contentRoot: '', project: {}, workspace: {} }))
    vi.stubGlobal('getOrBuildBrainCache', vi.fn().mockResolvedValue({ config: { locales: { default: 'en' } }, models: new Map() }))

    await withTestServer({
      routes: [{ path: '/api/workspaces/workspace-1/projects/project-1/migration/import-comments', handler: await loadImportComments() }],
    }, async ({ request }) => {
      const response = await request('/api/workspaces/workspace-1/projects/project-1/migration/import-comments', { method: 'POST' })
      expect(response.status).toBe(200)
      await expect(response.json()).resolves.toMatchObject({ received: 2, mapped: 2, inserted: 2, unmapped: [] })
      expect(importComments).toHaveBeenCalledWith(PROJECT, WORKSPACE, expect.objectContaining({
        comments: [
          expect.objectContaining({ source_id: '1', entry_id: 'entry-1', status: 'approved' }),
          expect.objectContaining({ source_id: '2', source_parent_id: '1', status: 'pending' }),
        ],
      }))
    })
  })

  it('import-comments re-reads an inline export from the repository when the row holds only the manifest', async () => {
    const base = stubSession()
    const importComments = vi.fn().mockResolvedValue({ inserted: 2, skippedExisting: 0, orphanCount: 0, orphanParents: [], maxDepth: 1, threadsClosed: 0 })
    const stored = {
      ...handoff,
      comments: { total: 2, export: { format: COMMENTS_EXPORT_FORMAT } },
      studio_intake: { source: { path: 'site/contentrain-handoff.json', ref: 'main' }, fileBytes: 1, manifestBytes: 1, comments: { kind: 'inline', bytes: 1 }, unresolvedTotal: 0 },
    }
    vi.stubGlobal('useDatabaseProvider', vi.fn().mockReturnValue({
      ...base,
      getProjectById: vi.fn().mockResolvedValue({ id: PROJECT, workspace_id: WORKSPACE, migration_handoff: stored }),
      importComments,
    }))
    const readFile = vi.fn(async (path: string, ref: string) => {
      if (path === 'site/contentrain-handoff.json' && ref === 'main') return JSON.stringify(handoff)
      throw new Error('404')
    })
    vi.stubGlobal('resolveProjectContext', vi.fn().mockResolvedValue({ git: { readFile }, contentRoot: 'site', project: {}, workspace: {} }))
    vi.stubGlobal('getOrBuildBrainCache', vi.fn().mockResolvedValue({ config: { locales: { default: 'en' } }, models: new Map() }))

    await withTestServer({
      routes: [{ path: '/api/workspaces/workspace-1/projects/project-1/migration/import-comments', handler: await loadImportComments() }],
    }, async ({ request }) => {
      const response = await request('/api/workspaces/workspace-1/projects/project-1/migration/import-comments', { method: 'POST' })
      expect(response.status).toBe(200)
      await expect(response.json()).resolves.toMatchObject({ received: 2, inserted: 2 })
      expect(readFile).toHaveBeenCalledWith('site/contentrain-handoff.json', 'main')
      expect(importComments).toHaveBeenCalledTimes(1)
    })
  })

  it('import-comments is 404 when the handoff file no longer carries the inline export', async () => {
    const base = stubSession()
    const importComments = vi.fn()
    const stored = {
      ...handoff,
      comments: { total: 2, export: { format: COMMENTS_EXPORT_FORMAT } },
      studio_intake: { source: { path: 'contentrain-handoff.json', ref: 'contentrain' }, fileBytes: 1, manifestBytes: 1, comments: { kind: 'inline', bytes: 1 }, unresolvedTotal: 0 },
    }
    vi.stubGlobal('useDatabaseProvider', vi.fn().mockReturnValue({
      ...base,
      getProjectById: vi.fn().mockResolvedValue({ id: PROJECT, workspace_id: WORKSPACE, migration_handoff: stored }),
      importComments,
    }))
    vi.stubGlobal('resolveProjectContext', vi.fn().mockResolvedValue({
      git: { readFile: vi.fn().mockResolvedValue(JSON.stringify({ ...handoff, comments: { total: 2 } })) },
      contentRoot: '',
      project: {},
      workspace: {},
    }))
    vi.stubGlobal('getOrBuildBrainCache', vi.fn().mockResolvedValue({ config: { locales: { default: 'en' } }, models: new Map() }))

    await withTestServer({
      routes: [{ path: '/api/workspaces/workspace-1/projects/project-1/migration/import-comments', handler: await loadImportComments() }],
    }, async ({ request }) => {
      expect((await request('/api/workspaces/workspace-1/projects/project-1/migration/import-comments', { method: 'POST' })).status).toBe(404)
      expect(importComments).not.toHaveBeenCalled()
    })
  })

  it('import-comments is 404 when the handoff has no export', async () => {
    const base = stubSession()
    vi.stubGlobal('useDatabaseProvider', vi.fn().mockReturnValue({
      ...base,
      getProjectById: vi.fn().mockResolvedValue({ id: PROJECT, workspace_id: WORKSPACE, migration_handoff: { ...handoff, comments: { total: 5 } } }),
      importComments: vi.fn(),
    }))

    await withTestServer({
      routes: [{ path: '/api/workspaces/workspace-1/projects/project-1/migration/import-comments', handler: await loadImportComments() }],
    }, async ({ request }) => {
      expect((await request('/api/workspaces/workspace-1/projects/project-1/migration/import-comments', { method: 'POST' })).status).toBe(404)
    })
  })
})

describe('migration handoff — pushed after the project was connected', () => {
  it('GET reads the file from the repository for an owner when nothing is stored yet, and persists it', async () => {
    const base = stubSession('owner')
    const getProjectById = vi.fn().mockResolvedValue({ id: PROJECT, migration_handoff: null, migration_handoff_synced_at: null })
    const setProjectMigrationHandoff = vi.fn().mockResolvedValue(undefined)
    const countCommentsByStatus = vi.fn().mockResolvedValue({ pending: 0, approved: 0, spam: 0, rejected: 0 })
    vi.stubGlobal('useDatabaseProvider', vi.fn().mockReturnValue({ ...base, getProjectById, setProjectMigrationHandoff, countCommentsByStatus }))
    vi.stubGlobal('resolveProjectContext', vi.fn().mockResolvedValue({
      git: { readFile: vi.fn(async (path: string, ref: string) => {
        if (path === 'contentrain-handoff.json' && ref === 'contentrain') return JSON.stringify(handoff)
        throw new Error('404')
      }) },
      contentRoot: '',
      project: { repo_full_name: 'acme/site', default_branch: 'main' },
      workspace: { id: WORKSPACE },
    }))

    await withTestServer({
      routes: [{ path: '/api/workspaces/workspace-1/projects/project-1/migration', handler: await loadGet() }],
    }, async ({ request }) => {
      const body = await (await request('/api/workspaces/workspace-1/projects/project-1/migration')).json() as Record<string, unknown>
      expect(body.present).toBe(true)
      expect(body.syncedAt).toEqual(expect.any(String))
      expect(body.summary).toMatchObject({ siteUrl: 'https://carriedils.com', needsRuntime: ['comments'] })
      expect(setProjectMigrationHandoff).toHaveBeenCalledWith(PROJECT, expect.objectContaining({ site_url: 'https://carriedils.com' }))
    })
  })

  it('GET re-reads a row stored before the manifest/comments split, for an owner', async () => {
    const base = stubSession('owner')
    const getProjectById = vi.fn().mockResolvedValue({ id: PROJECT, migration_handoff: handoff, migration_handoff_synced_at: '2026-09-03T11:00:00.000Z' })
    const setProjectMigrationHandoff = vi.fn().mockResolvedValue(undefined)
    const countCommentsByStatus = vi.fn().mockResolvedValue({ pending: 0, approved: 0, spam: 0, rejected: 0 })
    vi.stubGlobal('useDatabaseProvider', vi.fn().mockReturnValue({ ...base, getProjectById, setProjectMigrationHandoff, countCommentsByStatus }))
    vi.stubGlobal('resolveProjectContext', vi.fn().mockResolvedValue({
      git: { readFile: vi.fn(async (path: string, ref: string) => {
        if (path === 'contentrain-handoff.json' && ref === 'contentrain') return JSON.stringify(handoff)
        throw new Error('404')
      }) },
      contentRoot: '',
      project: { repo_full_name: 'acme/site', default_branch: 'main' },
      workspace: { id: WORKSPACE },
    }))

    await withTestServer({
      routes: [{ path: '/api/workspaces/workspace-1/projects/project-1/migration', handler: await loadGet() }],
    }, async ({ request }) => {
      const body = await (await request('/api/workspaces/workspace-1/projects/project-1/migration')).json() as { summary: MigrationHandoffSummary }
      expect(body.summary.comments).toMatchObject({ hasExport: true, source: 'inline' })
      const stored = setProjectMigrationHandoff.mock.calls[0]![1] as StoredMigrationHandoff
      expect(stored.comments?.export).toEqual({ format: COMMENTS_EXPORT_FORMAT })
      expect(stored.studio_intake?.comments.kind).toBe('inline')
    })
  })

  it('GET stays "absent" for a member (no persisting on their behalf) and when the repository has no file', async () => {
    const member = stubSession('member')
    const getProjectById = vi.fn().mockResolvedValue({ id: PROJECT, migration_handoff: null, migration_handoff_synced_at: null })
    const setProjectMigrationHandoff = vi.fn()
    vi.stubGlobal('useDatabaseProvider', vi.fn().mockReturnValue({ ...member, getProjectById, setProjectMigrationHandoff }))
    const resolveProjectContext = vi.fn().mockResolvedValue({
      git: { readFile: vi.fn().mockRejectedValue(new Error('404')) },
      contentRoot: '',
      project: { repo_full_name: 'acme/site', default_branch: 'main' },
      workspace: { id: WORKSPACE },
    })
    vi.stubGlobal('resolveProjectContext', resolveProjectContext)

    await withTestServer({
      routes: [{ path: '/api/workspaces/workspace-1/projects/project-1/migration', handler: await loadGet() }],
    }, async ({ request }) => {
      await expect((await request('/api/workspaces/workspace-1/projects/project-1/migration')).json()).resolves.toEqual({ present: false, syncedAt: null, summary: null, commentsImported: 0, claimExport: null })
      expect(resolveProjectContext).not.toHaveBeenCalled()
    })

    const owner = stubSession('owner')
    vi.stubGlobal('useDatabaseProvider', vi.fn().mockReturnValue({ ...owner, getProjectById, setProjectMigrationHandoff }))
    await withTestServer({
      routes: [{ path: '/api/workspaces/workspace-1/projects/project-1/migration', handler: await loadGet() }],
    }, async ({ request }) => {
      await expect((await request('/api/workspaces/workspace-1/projects/project-1/migration')).json()).resolves.toEqual({ present: false, syncedAt: null, summary: null, commentsImported: 0, claimExport: null })
      expect(resolveProjectContext).toHaveBeenCalledTimes(1)
      expect(setProjectMigrationHandoff).not.toHaveBeenCalled()
    })
  })
})

describe('migration comments — the export held on the Migrate grant (İP-2c)', () => {
  const exportPayload = (handoff.comments.export as { inline: unknown }).inline

  /** A grant row as migration 040 keeps it, and a comments table that skips what it already has. */
  function heldExportDb(status: 'ready' | 'unavailable' | 'expired' = 'ready') {
    const held = {
      grantId: 'grant-1',
      status: status as 'ready' | 'unavailable' | 'imported' | 'expired',
      comments: 2,
      expiresAt: '2026-10-27T00:00:00.000Z',
      importedAt: null as string | null,
      payload: (status === 'ready' ? exportPayload : null) as unknown,
    }
    const landed = new Set<string>()
    return {
      held,
      landed,
      getMigrateCommentsExport: vi.fn(async (workspaceId: string, repo: string, options?: { withPayload?: boolean }) => {
        if (workspaceId !== WORKSPACE || repo.toLowerCase() !== 'acme/site') return null
        const { payload, ...rest } = held
        return options?.withPayload ? { ...rest, payload } : rest
      }),
      markMigrateCommentsExportImported: vi.fn(async (grantId: string) => {
        if (grantId === held.grantId && held.status === 'ready') Object.assign(held, { status: 'imported', payload: null, importedAt: '2026-09-27T12:00:00.000Z' })
      }),
      importComments: vi.fn(async (_p: string, _w: string, input: { comments: Array<{ source_id: string }> }) => {
        let inserted = 0
        for (const row of input.comments) {
          if (landed.has(row.source_id)) continue
          landed.add(row.source_id)
          inserted++
        }
        return { inserted, skippedExisting: input.comments.length - inserted, orphanCount: 0, orphanParents: [], maxDepth: 1, threadsClosed: 0 }
      }),
      countCommentsByStatus: vi.fn(async () => ({ pending: 0, approved: landed.size, spam: 0, rejected: 0 })),
    }
  }

  function stubContext() {
    vi.stubGlobal('resolveProjectContext', vi.fn().mockResolvedValue({ git: { readFile: vi.fn().mockRejectedValue(new Error('404')) }, contentRoot: '', project: { repo_full_name: 'acme/site', default_branch: 'main' }, workspace: {} }))
    vi.stubGlobal('getOrBuildBrainCache', vi.fn().mockResolvedValue({ config: { locales: { default: 'en' } }, models: new Map() }))
  }

  // The test server matches by prefix: the longer path first.
  const routes = async () => [
    { path: '/api/workspaces/workspace-1/projects/project-1/migration/import-comments', handler: await loadImportComments() },
    { path: '/api/workspaces/workspace-1/projects/project-1/migration', handler: await loadGet() },
  ]

  it('imports the held export without any handoff, clears it at once, and a second run neither duplicates nor refetches', async () => {
    const base = stubSession()
    const fake = heldExportDb()
    const getProjectById = vi.fn().mockResolvedValue({ id: PROJECT, workspace_id: WORKSPACE, repo_full_name: 'Acme/Site', migration_handoff: null, migration_handoff_synced_at: null })
    vi.stubGlobal('useDatabaseProvider', vi.fn().mockReturnValue({ ...base, ...fake, getProjectById }))
    stubContext()

    await withTestServer({ routes: await routes() }, async ({ request }) => {
      const before = await (await request('/api/workspaces/workspace-1/projects/project-1/migration')).json() as Record<string, unknown>
      expect(before).toMatchObject({ present: false, claimExport: { status: 'ready', count: 2 }, commentsImported: 0 })

      const first = await request('/api/workspaces/workspace-1/projects/project-1/migration/import-comments', { method: 'POST' })
      expect(first.status).toBe(200)
      await expect(first.json()).resolves.toMatchObject({ received: 2, inserted: 2, skippedExisting: 0 })
      expect(fake.markMigrateCommentsExportImported).toHaveBeenCalledWith('grant-1')
      // Data minimisation: nothing of the export is kept once it has landed.
      expect(fake.held).toMatchObject({ status: 'imported', payload: null })

      const after = await (await request('/api/workspaces/workspace-1/projects/project-1/migration')).json() as Record<string, unknown>
      expect(after).toMatchObject({ claimExport: { status: 'imported', count: 2 }, commentsImported: 2 })

      // Nothing is held any more and there is no handoff: nothing to import.
      expect((await request('/api/workspaces/workspace-1/projects/project-1/migration/import-comments', { method: 'POST' })).status).toBe(404)
      expect(fake.importComments).toHaveBeenCalledTimes(1)
    })
  })

  it('a second import of the same comments (the handoff\'s copy) skips every one of them', async () => {
    const base = stubSession()
    const fake = heldExportDb()
    const getProjectById = vi.fn().mockResolvedValue({ id: PROJECT, workspace_id: WORKSPACE, repo_full_name: 'acme/site', migration_handoff: handoff })
    vi.stubGlobal('useDatabaseProvider', vi.fn().mockReturnValue({ ...base, ...fake, getProjectById }))
    stubContext()

    await withTestServer({ routes: await routes() }, async ({ request }) => {
      await expect((await request('/api/workspaces/workspace-1/projects/project-1/migration/import-comments', { method: 'POST' })).json()).resolves.toMatchObject({ inserted: 2 })
      await expect((await request('/api/workspaces/workspace-1/projects/project-1/migration/import-comments', { method: 'POST' })).json()).resolves.toMatchObject({ inserted: 0, skippedExisting: 2 })
      expect(fake.landed.size).toBe(2)
    })
  })

  it('shows an unavailable export so the card can point at the file upload, and imports nothing for it', async () => {
    const base = stubSession()
    const fake = heldExportDb('unavailable')
    const getProjectById = vi.fn().mockResolvedValue({ id: PROJECT, workspace_id: WORKSPACE, repo_full_name: 'acme/site', migration_handoff: null, migration_handoff_synced_at: null })
    vi.stubGlobal('useDatabaseProvider', vi.fn().mockReturnValue({ ...base, ...fake, getProjectById }))
    stubContext()

    await withTestServer({ routes: await routes() }, async ({ request }) => {
      await expect((await request('/api/workspaces/workspace-1/projects/project-1/migration')).json()).resolves.toMatchObject({ present: false, claimExport: { status: 'unavailable', count: 2 } })
      expect((await request('/api/workspaces/workspace-1/projects/project-1/migration/import-comments', { method: 'POST' })).status).toBe(404)
      expect(fake.importComments).not.toHaveBeenCalled()
      expect(fake.markMigrateCommentsExportImported).not.toHaveBeenCalled()
    })
  })

  it('never reaches another workspace\'s export, or a project of another workspace', async () => {
    const base = stubSession()
    const fake = heldExportDb()
    const getProjectById = vi.fn().mockResolvedValue({ id: PROJECT, workspace_id: 'workspace-2', repo_full_name: 'acme/site', migration_handoff: null })
    vi.stubGlobal('useDatabaseProvider', vi.fn().mockReturnValue({ ...base, ...fake, getProjectById }))
    stubContext()

    await withTestServer({ routes: await routes() }, async ({ request }) => {
      expect((await request('/api/workspaces/workspace-1/projects/project-1/migration/import-comments', { method: 'POST' })).status).toBe(404)
      expect(fake.getMigrateCommentsExport).not.toHaveBeenCalled()
      expect(fake.importComments).not.toHaveBeenCalled()
    })
  })
})

import { COMMENTS_EXPORT_FORMAT } from '@contentrain/types'
import { describe, expect, it, vi } from 'vitest'
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
      await expect((await request('/api/workspaces/workspace-1/projects/project-1/migration')).json()).resolves.toEqual({ present: false, syncedAt: null, summary: null, commentsImported: 0 })

      const second = await (await request('/api/workspaces/workspace-1/projects/project-1/migration')).json() as Record<string, unknown>
      expect(second.present).toBe(true)
      expect(second.commentsImported).toBe(2)
      expect(second.summary).toMatchObject({ siteUrl: 'https://carriedils.com', needsRuntime: ['comments'], comments: { total: 2, hasExport: true } })
      expect(base.getProjectMember).toHaveBeenCalledWith(PROJECT, 'user-1')
    })
  })

  it('sync reads contentrain-handoff.json from the repo, enriches repository, and stores it', async () => {
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

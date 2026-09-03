import { COMMENTS_EXPORT_FORMAT } from '@contentrain/types'
import { describe, expect, it, vi } from 'vitest'
import { withTestServer } from '../helpers/http'

async function loadPublicGet() {
  return (await import('../../server/api/comments/v1/[projectId]/[modelId]/[entryId].get')).default
}
async function loadPublicPost() {
  return (await import('../../server/api/comments/v1/[projectId]/[modelId]/[entryId].post')).default
}
async function loadCorsMiddleware() {
  return (await import('../../server/middleware/00.public-cors')).default
}
async function loadModerationList() {
  return (await import('../../server/api/workspaces/[workspaceId]/projects/[projectId]/comments/index.get')).default
}
async function loadModerationPatch() {
  return (await import('../../server/api/workspaces/[workspaceId]/projects/[projectId]/comments/[commentId].patch')).default
}
async function loadReply() {
  return (await import('../../server/api/workspaces/[workspaceId]/projects/[projectId]/comments/[commentId]/reply.post')).default
}
async function loadImport() {
  return (await import('../../server/api/workspaces/[workspaceId]/projects/[projectId]/comments/import.post')).default
}

const PROJECT = 'project-1'
const WORKSPACE = 'workspace-1'

const approvedRoot = {
  id: '11111111-1111-4111-8111-111111111111',
  project_id: PROJECT,
  workspace_id: WORKSPACE,
  model_id: 'posts',
  entry_id: 'entry-1',
  locale: 'en',
  parent_id: null,
  root_id: '11111111-1111-4111-8111-111111111111',
  depth: 0,
  author_name: 'Ada',
  author_email: 'ada@example.com',
  author_url: null,
  author_user_id: null,
  body: 'first',
  type: 'comment',
  status: 'approved',
  source: 'web',
  source_ip: '203.0.113.9',
  user_agent: 'ua',
  referrer: 'https://blog.example/post',
  created_at: '2026-01-01T00:00:00.000Z',
}

function stubPublicGlobals(options: { config?: Record<string, unknown>, plan?: string, features?: Record<string, boolean> } = {}) {
  const config = { enabled: true, requireApproval: true, maxDepth: 3, requireEmail: true, honeypot: true, captcha: null, rateLimitPerIp: 5, ...options.config }
  const features: Record<string, boolean> = { 'comments.enabled': true, 'comments.captcha': true, 'comments.auto_approve': true, 'comments.webhook_notification': false, ...options.features }

  vi.stubGlobal('getRouterParam', vi.fn((_: unknown, key: string) => {
    if (key === 'projectId') return PROJECT
    if (key === 'modelId') return 'posts'
    if (key === 'entryId') return 'entry-1'
    return undefined
  }))
  vi.stubGlobal('getWorkspacePlan', vi.fn().mockReturnValue(options.plan ?? 'pro'))
  vi.stubGlobal('hasFeature', vi.fn((_: string, feature: string) => features[feature] ?? false))
  vi.stubGlobal('getPlanLimit', vi.fn((_: string, limit: string) => limit === 'comments.models' ? 15 : limit === 'comments.per_month' ? 1000 : 10))
  vi.stubGlobal('useGitProvider', vi.fn().mockReturnValue({}))
  vi.stubGlobal('normalizeContentRoot', vi.fn().mockReturnValue('.contentrain'))
  vi.stubGlobal('getOrBuildBrainCache', vi.fn().mockResolvedValue({
    models: new Map([['posts', { id: 'posts', kind: 'collection', comments: config }]]),
  }))
  vi.stubGlobal('emitWebhookEvent', vi.fn().mockResolvedValue(undefined))

  return { config, features }
}

describe('public comment routes', () => {
  it('GET returns approved threads with public fields only, plus the embed config', async () => {
    stubPublicGlobals()
    const listPublicComments = vi.fn().mockResolvedValue({
      roots: [approvedRoot],
      replies: [{ ...approvedRoot, id: '22222222-2222-4222-8222-222222222222', parent_id: approvedRoot.id, depth: 1, body: 'reply', source: 'studio', author_user_id: 'user-1', author_name: 'Mod', created_at: '2026-01-02T00:00:00.000Z' }],
      total: 1,
    })
    vi.stubGlobal('useDatabaseProvider', vi.fn().mockReturnValue({
      getProjectById: vi.fn().mockResolvedValue({ id: PROJECT, workspace_id: WORKSPACE, repo_full_name: 'acme/site', content_root: '.contentrain' }),
      getWorkspaceById: vi.fn().mockResolvedValue({ id: WORKSPACE, plan: 'pro', github_installation_id: 42, overage_settings: null }),
      getCommentThread: vi.fn().mockResolvedValue(null),
      listPublicComments,
    }))

    await withTestServer({
      middleware: [await loadCorsMiddleware()],
      routes: [{ path: '/api/comments/v1/project-1/posts/entry-1', handler: await loadPublicGet() }],
    }, async ({ request }) => {
      const response = await request('/api/comments/v1/project-1/posts/entry-1?locale=en&page=2&limit=5&sort=newest')
      expect(response.status).toBe(200)
      expect(response.headers.get('access-control-allow-origin')).toBe('*')

      const body = await response.json() as { comments: Array<Record<string, unknown>>, config: Record<string, unknown>, total: number, page: number }
      expect(body.total).toBe(1)
      expect(body.page).toBe(2)
      expect(body.config).toMatchObject({ closed: false, requireApproval: true, maxDepth: 3, captcha: null, honeypotField: '_hp' })
      expect(listPublicComments).toHaveBeenCalledWith(PROJECT, { model_id: 'posts', entry_id: 'entry-1', locale: 'en' }, { page: 2, limit: 5, sort: 'newest' })

      const [root] = body.comments
      expect(root).toMatchObject({ id: approvedRoot.id, author: { name: 'Ada', isModerator: false }, body: 'first' })
      expect((root!.replies as Array<Record<string, unknown>>)[0]).toMatchObject({ body: 'reply', author: { name: 'Mod', isModerator: true } })

      const raw = JSON.stringify(body)
      for (const secret of ['ada@example.com', '203.0.113.9', 'blog.example/post', '"ua"'])
        expect(raw).not.toContain(secret)
    })
  })

  it('CORS middleware answers the preflight with 204 before any route runs', async () => {
    await withTestServer({
      middleware: [await loadCorsMiddleware()],
      routes: [],
    }, async ({ request }) => {
      const response = await request('/api/comments/v1/project-1/posts/entry-1', { method: 'OPTIONS' })
      expect(response.status).toBe(204)
      expect(response.headers.get('access-control-allow-methods')).toContain('POST')
    })
  })

  it('POST validates, sanitizes, and stores through the atomic RPC; pending status reflects requireApproval', async () => {
    stubPublicGlobals()
    const createCommentIfAllowed = vi.fn().mockImplementation(async (_ws: string, _limit: number, input: Record<string, unknown>) => ({
      allowed: true,
      currentCount: 1,
      comment: { ...approvedRoot, id: '33333333-3333-4333-8333-333333333333', body: input.body, author_name: input.author_name, status: input.status },
    }))
    vi.stubGlobal('useDatabaseProvider', vi.fn().mockReturnValue({
      getProjectById: vi.fn().mockResolvedValue({ id: PROJECT, workspace_id: WORKSPACE, repo_full_name: 'acme/site', content_root: '.contentrain' }),
      getWorkspaceById: vi.fn().mockResolvedValue({ id: WORKSPACE, plan: 'pro', github_installation_id: 42, overage_settings: null }),
      createCommentIfAllowed,
    }))

    await withTestServer({
      routes: [{ path: '/api/comments/v1/project-1/posts/entry-1', handler: await loadPublicPost() }],
    }, async ({ request }) => {
      // Missing name → field error, no DB call
      const bad = await request('/api/comments/v1/project-1/posts/entry-1', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ author: { email: 'a@b.co' }, body: 'x' }),
      })
      expect(await bad.json()).toEqual({ success: false, errors: [{ field: 'author.name', message: 'comments.author_required' }] })
      expect(createCommentIfAllowed).not.toHaveBeenCalled()

      // Honeypot → silent success, no DB call
      const bot = await request('/api/comments/v1/project-1/posts/entry-1', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ author: { name: 'Bot', email: 'bot@b.co' }, body: 'buy', _hp: 'filled' }),
      })
      expect(await bot.json()).toEqual({ success: true, status: 'pending' })
      expect(createCommentIfAllowed).not.toHaveBeenCalled()

      // Good submission → sanitized body, pending, public shape back
      const ok = await request('/api/comments/v1/project-1/posts/entry-1?locale=en', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': '198.51.100.7' },
        body: JSON.stringify({ author: { name: '<b>Ada</b>', email: 'ADA@Example.com', url: 'https://ada.dev' }, body: 'hello <script>x</script>world' }),
      })
      expect(ok.status).toBe(200)
      const payload = await ok.json() as { success: boolean, status: string, comment: Record<string, unknown> }
      expect(payload.success).toBe(true)
      expect(payload.status).toBe('pending')
      expect(payload.comment).toMatchObject({ body: 'hello xworld', author: { name: 'Ada' } })
      expect(JSON.stringify(payload)).not.toContain('example.com')

      expect(createCommentIfAllowed).toHaveBeenCalledWith(WORKSPACE, 1000, expect.objectContaining({
        project_id: PROJECT,
        model_id: 'posts',
        entry_id: 'entry-1',
        locale: 'en',
        parent_id: null,
        max_depth: 3,
        author_name: 'Ada',
        author_email: 'ada@example.com',
        author_url: 'https://ada.dev/',
        body: 'hello xworld',
        status: 'pending',
        source_ip: '198.51.100.7',
      }))
    })
  })

  it('POST maps RPC refusals: closed thread → 403, quota → 429, bad parent → field error', async () => {
    stubPublicGlobals({ config: { requireApproval: false } })
    const outcomes = [
      { allowed: false, reason: 'thread_closed' },
      { allowed: false, reason: 'monthly_limit', currentCount: 1000 },
      { allowed: false, reason: 'parent_not_found' },
    ]
    const createCommentIfAllowed = vi.fn().mockImplementation(async () => outcomes.shift())
    vi.stubGlobal('useDatabaseProvider', vi.fn().mockReturnValue({
      getProjectById: vi.fn().mockResolvedValue({ id: PROJECT, workspace_id: WORKSPACE, repo_full_name: 'acme/site', content_root: '.contentrain' }),
      getWorkspaceById: vi.fn().mockResolvedValue({ id: WORKSPACE, plan: 'pro', github_installation_id: 42, overage_settings: null }),
      createCommentIfAllowed,
    }))

    await withTestServer({
      routes: [{ path: '/api/comments/v1/project-1/posts/entry-1', handler: await loadPublicPost() }],
    }, async ({ request }) => {
      const send = () => request('/api/comments/v1/project-1/posts/entry-1', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ author: { name: 'Ada', email: 'a@b.co' }, body: 'hi', parentId: approvedRoot.id }),
      })
      expect((await send()).status).toBe(403)
      expect((await send()).status).toBe(429)
      const third = await send()
      expect(third.status).toBe(200)
      expect(await third.json()).toEqual({ success: false, errors: [{ field: 'parentId', message: 'comments.parent_not_found' }] })
      // requireApproval=false + comments.auto_approve → approved
      expect(createCommentIfAllowed.mock.calls[0]![2]).toMatchObject({ status: 'approved' })
    })
  })

  it('GET is 404 when the model has comments disabled and 403 when the plan lacks the feature', async () => {
    const db = {
      getProjectById: vi.fn().mockResolvedValue({ id: PROJECT, workspace_id: WORKSPACE, repo_full_name: 'acme/site', content_root: '.contentrain' }),
      getWorkspaceById: vi.fn().mockResolvedValue({ id: WORKSPACE, plan: 'free', github_installation_id: 42, overage_settings: null }),
      getCommentThread: vi.fn(),
      listPublicComments: vi.fn(),
    }

    stubPublicGlobals({ config: { enabled: false } })
    vi.stubGlobal('useDatabaseProvider', vi.fn().mockReturnValue(db))
    await withTestServer({
      routes: [{ path: '/api/comments/v1/project-1/posts/entry-1', handler: await loadPublicGet() }],
    }, async ({ request }) => {
      expect((await request('/api/comments/v1/project-1/posts/entry-1')).status).toBe(404)
    })

    stubPublicGlobals({ features: { 'comments.enabled': false } })
    vi.stubGlobal('useDatabaseProvider', vi.fn().mockReturnValue(db))
    await withTestServer({
      routes: [{ path: '/api/comments/v1/project-1/posts/entry-1', handler: await loadPublicGet() }],
    }, async ({ request }) => {
      expect((await request('/api/comments/v1/project-1/posts/entry-1')).status).toBe(403)
    })
  })
})

function stubModerationGlobals(role = 'owner') {
  vi.stubGlobal('getRouterParam', vi.fn((_: unknown, key: string) => {
    if (key === 'workspaceId') return WORKSPACE
    if (key === 'projectId') return PROJECT
    if (key === 'commentId') return approvedRoot.id
    return undefined
  }))
  vi.stubGlobal('requireAuth', vi.fn().mockReturnValue({ user: { id: 'user-1', email: 'mod@acme.dev' }, accessToken: 'token-1' }))
  vi.stubGlobal('getWorkspacePlan', vi.fn().mockReturnValue('pro'))
  vi.stubGlobal('hasFeature', vi.fn((_: string, feature: string) => feature !== 'comments.webhook_notification'))
  vi.stubGlobal('emitWebhookEvent', vi.fn().mockResolvedValue(undefined))
  return {
    requireWorkspaceRole: vi.fn().mockResolvedValue(role),
    getProjectForWorkspace: vi.fn().mockResolvedValue({ id: PROJECT }),
    getProjectMember: vi.fn().mockResolvedValue({ id: 'pm-1', role: 'editor' }),
    getWorkspaceById: vi.fn().mockResolvedValue({ plan: 'pro' }),
  }
}

describe('comment moderation routes', () => {
  it('lists with filters and status counts for a project member', async () => {
    const base = stubModerationGlobals('member')
    const listComments = vi.fn().mockResolvedValue({ comments: [approvedRoot], total: 1 })
    const countCommentsByStatus = vi.fn().mockResolvedValue({ pending: 2, approved: 1, spam: 0, rejected: 0 })
    vi.stubGlobal('useDatabaseProvider', vi.fn().mockReturnValue({ ...base, listComments, countCommentsByStatus }))

    await withTestServer({
      routes: [{ path: '/api/workspaces/workspace-1/projects/project-1/comments', handler: await loadModerationList() }],
    }, async ({ request }) => {
      const response = await request('/api/workspaces/workspace-1/projects/project-1/comments?status=pending&modelId=posts&limit=10&sort=oldest')
      expect(response.status).toBe(200)
      await expect(response.json()).resolves.toMatchObject({ total: 1, counts: { pending: 2, approved: 1 }, page: 1, limit: 10 })
      expect(listComments).toHaveBeenCalledWith(WORKSPACE, PROJECT, expect.objectContaining({ status: 'pending', modelId: 'posts', limit: 10, sort: 'oldest' }))
      expect(base.getProjectMember).toHaveBeenCalledWith(PROJECT, 'user-1')
    })
  })

  it('PATCH approves an owned comment and rejects an unknown status', async () => {
    const base = stubModerationGlobals()
    const updateCommentStatus = vi.fn().mockResolvedValue({ ...approvedRoot, status: 'approved' })
    vi.stubGlobal('useDatabaseProvider', vi.fn().mockReturnValue({
      ...base,
      getComment: vi.fn().mockResolvedValue({ ...approvedRoot, status: 'pending' }),
      updateCommentStatus,
    }))

    await withTestServer({
      routes: [{ path: `/api/workspaces/workspace-1/projects/project-1/comments/${approvedRoot.id}`, handler: await loadModerationPatch() }],
    }, async ({ request }) => {
      const bad = await request(`/api/workspaces/workspace-1/projects/project-1/comments/${approvedRoot.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status: 'published' }),
      })
      expect(bad.status).toBe(400)

      const ok = await request(`/api/workspaces/workspace-1/projects/project-1/comments/${approvedRoot.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status: 'approved' }),
      })
      expect(ok.status).toBe(200)
      expect(updateCommentStatus).toHaveBeenCalledWith(approvedRoot.id, 'approved', 'user-1')
    })
  })

  it('PATCH is 404 for a comment owned by another project', async () => {
    const base = stubModerationGlobals()
    vi.stubGlobal('useDatabaseProvider', vi.fn().mockReturnValue({
      ...base,
      getComment: vi.fn().mockResolvedValue({ ...approvedRoot, project_id: 'project-2' }),
      updateCommentStatus: vi.fn(),
    }))

    await withTestServer({
      routes: [{ path: `/api/workspaces/workspace-1/projects/project-1/comments/${approvedRoot.id}`, handler: await loadModerationPatch() }],
    }, async ({ request }) => {
      const response = await request(`/api/workspaces/workspace-1/projects/project-1/comments/${approvedRoot.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status: 'spam' }),
      })
      expect(response.status).toBe(404)
    })
  })

  it('reply approves a pending parent first and publishes a studio-sourced reply under it', async () => {
    const base = stubModerationGlobals()
    const updateCommentStatus = vi.fn().mockResolvedValue({ ...approvedRoot, status: 'approved' })
    const createComment = vi.fn().mockImplementation(async (input: Record<string, unknown>) => ({ ...approvedRoot, id: 'reply-1', ...input }))
    vi.stubGlobal('useDatabaseProvider', vi.fn().mockReturnValue({
      ...base,
      getComment: vi.fn().mockResolvedValue({ ...approvedRoot, status: 'pending' }),
      getProfile: vi.fn().mockResolvedValue({ id: 'user-1', display_name: 'Grace', email: 'mod@acme.dev' }),
      updateCommentStatus,
      createComment,
    }))

    await withTestServer({
      routes: [{ path: `/api/workspaces/workspace-1/projects/project-1/comments/${approvedRoot.id}/reply`, handler: await loadReply() }],
    }, async ({ request }) => {
      const response = await request(`/api/workspaces/workspace-1/projects/project-1/comments/${approvedRoot.id}/reply`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ body: 'Thanks <i>Ada</i>!' }),
      })
      expect(response.status).toBe(200)
      expect(updateCommentStatus).toHaveBeenCalledWith(approvedRoot.id, 'approved', 'user-1')
      expect(createComment).toHaveBeenCalledWith(expect.objectContaining({
        parent_id: approvedRoot.id,
        model_id: 'posts',
        entry_id: 'entry-1',
        author_name: 'Grace',
        author_user_id: 'user-1',
        body: 'Thanks Ada!',
        status: 'approved',
        source: 'studio',
      }))
    })
  })

  it('import validates the export, maps posts through entries, reports unmapped rows, and forwards to the RPC', async () => {
    const base = stubModerationGlobals()
    const importComments = vi.fn().mockResolvedValue({ inserted: 2, skippedExisting: 0, orphanCount: 0, orphanParents: [], maxDepth: 1, threadsClosed: 1 })
    vi.stubGlobal('useDatabaseProvider', vi.fn().mockReturnValue({ ...base, importComments }))

    const exportPayload = {
      version: 1,
      format: COMMENTS_EXPORT_FORMAT,
      source: { kind: 'wxr' },
      generated_at: '2026-01-10T00:00:00.000Z',
      entries: { 10: { model_id: 'posts', entry_id: 'entry-1' } },
      threads_closed: [10],
      comments: [
        { id: 1, post: 10, parent: null, author: 'Ada', date: '2020-05-01T10:00:00Z', content: '<p>Hi</p>', approved: '1' },
        { id: 2, post: 10, parent: 1, author: 'Bob', date: '2020-05-02T10:00:00Z', content: 'Yo', approved: '0' },
        { id: 3, post: 77, parent: null, author: 'Ghost', date: null, content: 'no entry', approved: '1' },
      ],
    }

    await withTestServer({
      routes: [{ path: '/api/workspaces/workspace-1/projects/project-1/comments/import', handler: await loadImport() }],
    }, async ({ request }) => {
      const bad = await request('/api/workspaces/workspace-1/projects/project-1/comments/import', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...exportPayload, format: 'wp-comments@0' }),
      })
      expect(bad.status).toBe(400)
      expect(importComments).not.toHaveBeenCalled()

      const ok = await request('/api/workspaces/workspace-1/projects/project-1/comments/import?locale=tr', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(exportPayload),
      })
      expect(ok.status).toBe(200)
      await expect(ok.json()).resolves.toMatchObject({
        received: 3,
        mapped: 2,
        inserted: 2,
        unmapped: [{ comment_id: 3, post: 77 }],
        orphanCount: 0,
        threadsClosed: 1,
      })
      expect(importComments).toHaveBeenCalledWith(PROJECT, WORKSPACE, {
        comments: [
          expect.objectContaining({ source_id: '1', source_parent_id: null, entry_id: 'entry-1', locale: 'tr', status: 'approved', body: 'Hi', created_at: '2020-05-01T10:00:00.000Z' }),
          expect.objectContaining({ source_id: '2', source_parent_id: '1', status: 'pending', body: 'Yo' }),
        ],
        threads_closed: [{ model_id: 'posts', entry_id: 'entry-1', locale: 'tr' }],
      })
    })
  })

  it('import is refused for a workspace member', async () => {
    const base = stubModerationGlobals('member')
    base.requireWorkspaceRole = vi.fn().mockRejectedValue(Object.assign(new Error('forbidden'), { statusCode: 403 }))
    vi.stubGlobal('useDatabaseProvider', vi.fn().mockReturnValue({ ...base, importComments: vi.fn() }))

    await withTestServer({
      routes: [{ path: '/api/workspaces/workspace-1/projects/project-1/comments/import', handler: await loadImport() }],
    }, async ({ request }) => {
      const response = await request('/api/workspaces/workspace-1/projects/project-1/comments/import', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      })
      expect(response.status).toBe(403)
    })
  })
})

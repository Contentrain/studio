import * as h3 from 'h3'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createPostgresDatabaseProvider } from '../../server/providers/postgres-db'
import { deleteSeededUser, getDb, seedUser, sql } from '../contract/helpers'
import type { SeededUser } from '../contract/helpers'
import { withTestServer } from '../helpers/http'

describe('comment HTTP → PostgreSQL → approval → public read', () => {
  const db = createPostgresDatabaseProvider()
  let user: SeededUser
  let projectId: string
  beforeAll(async () => {
    user = await seedUser('wp-http')
    await sql`UPDATE public.workspaces SET github_installation_id = 42 WHERE id = ${user.workspaceId}`.execute(getDb())
    const project = await sql<{ id: string }>`INSERT INTO public.projects (workspace_id, repo_full_name)
      VALUES (${user.workspaceId}, 'acceptance/wp-http') RETURNING id`.execute(getDb())
    projectId = project.rows[0]!.id
    for (const name of ['defineEventHandler', 'getRouterParam', 'getQuery', 'readBody', 'getHeader', 'getRequestIP', 'getRequestPath', 'setResponseHeader', 'setResponseStatus', 'createError'] as const)
      vi.stubGlobal(name, h3[name])
    vi.stubGlobal('useDatabaseProvider', () => db)
    // Explicit seams: Git model config, licensing, rate limiter. HTTP handlers,
    // validation, sanitization, database methods/SQL and public serialization are real.
    vi.stubGlobal('useGitProvider', () => ({}))
    vi.stubGlobal('normalizeContentRoot', () => '')
    vi.stubGlobal('getWorkspacePlan', () => 'pro')
    vi.stubGlobal('hasFeature', (_plan: string, key: string) => key === 'comments.enabled')
    vi.stubGlobal('getPlanLimit', () => 1000)
    vi.stubGlobal('checkRateLimit', async () => ({ allowed: true }))
    vi.stubGlobal('getOrBuildBrainCache', async () => ({
      config: { locales: { default: 'en' } },
      models: new Map(['posts', 'pages'].map(id => [id, { id, kind: 'collection', comments: {
        enabled: true, requireApproval: true, requireEmail: true, captcha: null, honeypot: true,
      } }])),
    }))
  })
  afterAll(async () => {
    if (user) await deleteSeededUser(user.userId)
  })

  it('keeps pending submissions private, reveals approved ones and isolates entries/locales', async () => {
    const get = (await import('../../server/api/comments/v1/[projectId]/[modelId]/[entryId].get')).default
    const post = (await import('../../server/api/comments/v1/[projectId]/[modelId]/[entryId].post')).default
    const cors = (await import('../../server/middleware/00.public-cors')).default
    const router = h3.createRouter()
    const pattern = '/api/comments/v1/:projectId/:modelId/:entryId'
    router.get(pattern, get)
    router.post(pattern, post)
    await withTestServer({ middleware: [cors], routes: [{ path: '/', handler: router.handler }] }, async ({ request }) => {
      const path = `/api/comments/v1/${projectId}/posts/entry-a`
      const headers = { 'Content-Type': 'application/json', 'Origin': 'https://generated.example' }
      const preflight = await request(path, { method: 'OPTIONS', headers })
      expect(preflight.status).toBe(204)
      expect(preflight.headers.get('access-control-allow-origin')).toBe('*')

      const submission = await request(path, { method: 'POST', headers, body: JSON.stringify({
        author: { name: 'Fixture visitor', email: 'private@acceptance.test' }, body: 'A real persisted comment',
      }) })
      expect(submission.status).toBe(200)
      const result = await submission.json()
      expect(result).toMatchObject({ success: true, status: 'pending' })
      const commentId = result.comment.id as string
      const persisted = await sql<{ status: string, author_email: string }>`SELECT status, author_email FROM public.comments WHERE id = ${commentId}`.execute(getDb())
      expect(persisted.rows[0]).toMatchObject({ status: 'pending', author_email: 'private@acceptance.test' })
      expect((await (await request(path)).json()).total).toBe(0)

      // Deliberately provider-level approval, NOT an authenticated moderation UI test.
      await db.updateCommentStatus(commentId, 'approved', user.userId)
      const visible = await (await request(path)).json()
      expect(visible.total).toBe(1)
      expect(visible.comments[0]).toMatchObject({ id: commentId, body: 'A real persisted comment' })
      expect(JSON.stringify(visible)).not.toContain('private@acceptance.test')
      expect(JSON.stringify(visible)).not.toContain('author_email')
      expect((await (await request(`${path}?locale=tr`)).json()).total).toBe(0)
      expect((await (await request(`/api/comments/v1/${projectId}/pages/entry-a`)).json()).total).toBe(0)
      expect((await (await request(`/api/comments/v1/${projectId}/posts/entry-b`)).json()).total).toBe(0)

      await db.updateCommentStatus(commentId, 'rejected', user.userId)
      expect((await (await request(path)).json()).total).toBe(0)
    })
  })
})

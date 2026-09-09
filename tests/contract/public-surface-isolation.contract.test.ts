/**
 * Tenant isolation + moderation visibility for the public surfaces, on a
 * real PostgreSQL through the postgres DatabaseProvider — the half of the
 * "pending/private content must not appear publicly" gate the mocked route
 * tests cannot prove.
 *
 *   - Two workspaces, one project each, the SAME model/entry/locale key.
 *     Nothing written in A is visible through B's public read, thread,
 *     counts or moderation listing, and B's moderation scope cannot touch A.
 *   - Moderation drives visibility: pending is hidden, approve shows it,
 *     reject hides it again together with its (still approved) replies.
 *   - Form submissions: per-model counts, listing and bulk scope are bound
 *     to workspace + project.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { commentMethods } from '../../server/providers/postgres-db/comments'
import { formMethods } from '../../server/providers/postgres-db/forms'
import { deleteSeededUser, getDb, seedUser, sql } from './helpers'
import type { SeededUser } from './helpers'

const KEY = { model_id: 'posts', entry_id: 'hello-world', locale: 'en' }

interface Tenant extends SeededUser { projectId: string }

async function seedTenant(label: string): Promise<Tenant> {
  const user = await seedUser(label)
  const project = await sql<{ id: string }>`
    INSERT INTO public.projects (workspace_id, repo_full_name)
    VALUES (${user.workspaceId}, ${`contentrain/${label}-fixture`}) RETURNING id
  `.execute(getDb())
  return { ...user, projectId: project.rows[0]!.id }
}

describe('postgres-db public-surface isolation (contract)', () => {
  const comments = commentMethods()
  const forms = formMethods()
  let a: Tenant
  let b: Tenant

  beforeAll(async () => {
    a = await seedTenant('isolation-a')
    b = await seedTenant('isolation-b')
  })

  afterAll(async () => {
    await deleteSeededUser(a.userId)
    await deleteSeededUser(b.userId)
  })

  const submit = (t: Tenant, over: Record<string, unknown> = {}) => comments.createCommentIfAllowed(t.workspaceId, 1000, {
    project_id: t.projectId,
    workspace_id: t.workspaceId,
    ...KEY,
    max_depth: 4,
    author_name: 'Visitor',
    author_email: 'visitor@example.com',
    body: 'hello',
    ...over,
  })

  it('comments written in one project never surface through another project with the same entry key', async () => {
    const root = await submit(a, { status: 'approved', body: 'A root' })
    expect(root.allowed).toBe(true)
    const reply = await submit(a, { status: 'approved', body: 'A reply', parent_id: root.comment!.id as string })
    expect(reply.allowed).toBe(true)
    await submit(a, { body: 'A pending' })

    // Public read — B sees an empty thread, A sees only the approved chain.
    const viaB = await comments.listPublicComments(b.projectId, KEY, { limit: 50 })
    expect(viaB).toEqual({ roots: [], replies: [], total: 0 })
    const viaA = await comments.listPublicComments(a.projectId, KEY, { limit: 50 })
    expect(viaA.total).toBe(1)
    expect(viaA.roots.map(r => r.body)).toEqual(['A root'])
    expect(viaA.replies.map(r => r.body)).toEqual(['A reply'])

    // Thread state is per project: closing A leaves B open.
    await comments.setCommentThreadClosed(a.projectId, a.workspaceId, KEY, true, a.userId)
    expect((await comments.getCommentThread(a.projectId, KEY))?.closed_at).not.toBeNull()
    expect(await comments.getCommentThread(b.projectId, KEY)).toBeNull()
    expect(await submit(a, { body: 'blocked' })).toMatchObject({ allowed: false, reason: 'thread_closed' })
    const bOpen = await submit(b, { status: 'approved', body: 'B root' })
    expect(bOpen.allowed).toBe(true)
    await comments.setCommentThreadClosed(a.projectId, a.workspaceId, KEY, false)

    // Moderation surfaces and counters are scoped too.
    expect((await comments.listComments(b.workspaceId, a.projectId, { limit: 50 })).total).toBe(0)
    expect((await comments.listComments(a.workspaceId, b.projectId, { limit: 50 })).total).toBe(0)
    expect((await comments.listComments(a.workspaceId, a.projectId, { limit: 50 })).total).toBe(3)
    expect(await comments.countCommentsByStatus(a.projectId, 'posts')).toEqual({ pending: 1, approved: 2, spam: 0, rejected: 0 })
    expect(await comments.countCommentsByStatus(b.projectId, 'posts')).toEqual({ pending: 0, approved: 1, spam: 0, rejected: 0 })
    expect(await comments.countMonthlyComments(a.workspaceId)).toBe(3)
    expect(await comments.countMonthlyComments(b.workspaceId)).toBe(1)

    // A moderator acting under workspace B cannot flip A's rows.
    const touched = await comments.bulkUpdateComments([root.comment!.id as string], 'spam', b.userId, { workspaceId: b.workspaceId, projectId: b.projectId })
    expect(touched).toBe(0)
    expect((await comments.getComment(root.comment!.id as string))!.status).toBe('approved')

    // A reply cannot be hung under another project's comment (trigger refuses the cross-project parent).
    expect(await submit(b, { body: 'cross', parent_id: root.comment!.id as string })).toMatchObject({ allowed: false, reason: 'parent_not_found' })
  })

  it('moderation drives public visibility: pending hidden → approved shown → rejected hidden with its replies', async () => {
    const key = { ...KEY, entry_id: 'moderated' }
    const pending = await comments.createCommentIfAllowed(a.workspaceId, 1000, {
      project_id: a.projectId,
      workspace_id: a.workspaceId,
      ...key,
      max_depth: 4,
      author_name: 'Visitor',
      author_email: 'visitor@example.com',
      body: 'awaiting moderation',
    })
    expect(pending.comment!.status).toBe('pending')
    const id = pending.comment!.id as string

    expect((await comments.listPublicComments(a.projectId, key, { limit: 10 })).total).toBe(0)

    await comments.updateCommentStatus(id, 'approved', a.userId)
    const shown = await comments.listPublicComments(a.projectId, key, { limit: 10 })
    expect(shown.roots.map(r => r.id)).toEqual([id])

    // Moderator reply under the approved root is public...
    const reply = await comments.createComment({
      project_id: a.projectId,
      workspace_id: a.workspaceId,
      ...key,
      parent_id: id,
      author_user_id: a.userId,
      author_name: 'Moderator',
      author_email: null,
      body: 'thanks',
      status: 'approved',
      source: 'studio',
    })
    expect((await comments.listPublicComments(a.projectId, key, { limit: 10 })).replies.map(r => r.id)).toEqual([reply.id])

    // ...until the root is rejected: the whole branch leaves the public read, the reply row stays approved in moderation.
    await comments.updateCommentStatus(id, 'rejected', a.userId)
    expect(await comments.listPublicComments(a.projectId, key, { limit: 10 })).toEqual({ roots: [], replies: [], total: 0 })
    expect((await comments.getComment(reply.id as string))!.status).toBe('approved')
    expect(await comments.countCommentsByStatus(a.projectId, 'posts')).toMatchObject({ rejected: 1 })
  })

  it('form submissions: per-model counts, listing and bulk moderation are bound to workspace + project', async () => {
    const modelId = 'contact'
    const created = await forms.createFormSubmissionIfAllowed(a.workspaceId, 100, {
      project_id: a.projectId,
      workspace_id: a.workspaceId,
      model_id: modelId,
      data: { name: 'Ada', email: 'ada@example.com' },
      source_ip: '198.51.100.7',
      locale: 'en',
    })
    expect(created.allowed).toBe(true)
    const submissionId = created.submission!.id as string

    expect(await forms.countMonthlySubmissionsForModel(a.workspaceId, a.projectId, modelId)).toBe(1)
    expect(await forms.countMonthlySubmissionsForModel(b.workspaceId, b.projectId, modelId)).toBe(0)
    expect(await forms.countMonthlySubmissionsForModel(a.workspaceId, b.projectId, modelId)).toBe(0)
    expect(await forms.countMonthlySubmissions(b.workspaceId)).toBe(0)

    expect((await forms.listFormSubmissions(b.workspaceId, a.projectId, modelId)).total).toBe(0)
    expect((await forms.listFormSubmissions(a.workspaceId, b.projectId, modelId)).total).toBe(0)
    const own = await forms.listFormSubmissions(a.workspaceId, a.projectId, modelId)
    expect(own.total).toBe(1)
    expect(own.submissions[0]!.status).toBe('pending')

    expect(await forms.bulkUpdateSubmissions([submissionId], 'approved', b.userId, { workspaceId: b.workspaceId, projectId: b.projectId })).toBe(0)
    expect((await forms.getFormSubmission(submissionId))!.status).toBe('pending')
    expect(await forms.bulkUpdateSubmissions([submissionId], 'approved', a.userId, { workspaceId: a.workspaceId, projectId: a.projectId, modelId })).toBe(1)
    expect((await forms.getFormSubmission(submissionId))!.status).toBe('approved')
  })
})

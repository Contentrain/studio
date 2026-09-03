import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { CommentImportRow } from '../../server/providers/database'
import { commentMethods } from '../../server/providers/postgres-db/comments'
import { deleteSeededUser, getDb, seedUser, sql } from './helpers'
import type { SeededUser } from './helpers'

const KEY = { model_id: 'posts', entry_id: 'entry-1', locale: 'en' }

describe('postgres-db comments (contract)', () => {
  const methods = commentMethods()
  let user: SeededUser
  let projectId: string

  beforeAll(async () => {
    user = await seedUser('comments')
    const project = await sql<{ id: string }>`
      INSERT INTO public.projects (workspace_id, repo_full_name)
      VALUES (${user.workspaceId}, 'contentrain/comments-fixture') RETURNING id
    `.execute(getDb())
    projectId = project.rows[0]!.id
  })

  afterAll(async () => {
    await deleteSeededUser(user.userId)
  })

  function base(overrides: Record<string, unknown> = {}) {
    return {
      project_id: projectId,
      workspace_id: user.workspaceId,
      ...KEY,
      author_name: 'Ada',
      author_email: 'ada@example.com',
      body: 'hello',
      ...overrides,
    }
  }

  it('public submit: root → approved reply chain carries root/depth; pending parent is invisible; depth cap; quota', async () => {
    const root = await methods.createCommentIfAllowed(user.workspaceId, 100, { ...base(), max_depth: 2, status: 'approved' })
    expect(root.allowed).toBe(true)
    expect(root.comment!.root_id).toBe(root.comment!.id)
    expect(root.comment!.depth).toBe(0)
    expect(root.comment!.source).toBe('web')

    const reply = await methods.createCommentIfAllowed(user.workspaceId, 100, {
      ...base({ author_name: 'Bob', body: 'reply' }),
      parent_id: root.comment!.id as string,
      max_depth: 2,
      status: 'approved',
    })
    expect(reply.allowed).toBe(true)
    expect(reply.comment!.root_id).toBe(root.comment!.id)
    expect(reply.comment!.depth).toBe(1)

    // A pending comment cannot be replied to (it is not visible yet).
    const pending = await methods.createCommentIfAllowed(user.workspaceId, 100, { ...base({ body: 'pending' }), max_depth: 2 })
    expect(pending.comment!.status).toBe('pending')
    const toPending = await methods.createCommentIfAllowed(user.workspaceId, 100, {
      ...base({ body: 'nope' }),
      parent_id: pending.comment!.id as string,
      max_depth: 2,
    })
    expect(toPending).toMatchObject({ allowed: false, reason: 'parent_not_found' })

    // Depth cap gates new submissions only.
    const deep = await methods.createCommentIfAllowed(user.workspaceId, 100, {
      ...base({ body: 'deep' }),
      parent_id: reply.comment!.id as string,
      max_depth: 1,
    })
    expect(deep).toMatchObject({ allowed: false, reason: 'depth_exceeded' })

    // Monthly quota counts only web submissions (3 so far).
    const quota = await methods.createCommentIfAllowed(user.workspaceId, 3, { ...base({ body: 'over' }), max_depth: 2 })
    expect(quota).toMatchObject({ allowed: false, reason: 'monthly_limit', currentCount: 3 })
    expect(await methods.countMonthlyComments(user.workspaceId)).toBe(3)

    // Public listing: approved roots + approved replies, pending excluded.
    const pub = await methods.listPublicComments(projectId, KEY, { limit: 10 })
    expect(pub.total).toBe(1)
    expect(pub.roots.map(r => r.id)).toEqual([root.comment!.id])
    expect(pub.replies.map(r => r.id)).toEqual([reply.comment!.id])
  })

  it('thread close blocks public submit; reopen allows it; moderation listing + counts + status stamps', async () => {
    const closed = await methods.setCommentThreadClosed(projectId, user.workspaceId, KEY, true, user.userId)
    expect(closed.closed_at).not.toBeNull()
    expect(closed.closed_by).toBe(user.userId)

    const blocked = await methods.createCommentIfAllowed(user.workspaceId, 100, { ...base({ body: 'closed?' }), max_depth: 2 })
    expect(blocked).toMatchObject({ allowed: false, reason: 'thread_closed' })

    const reopened = await methods.setCommentThreadClosed(projectId, user.workspaceId, KEY, false)
    expect(reopened.closed_at).toBeNull()
    expect(await methods.getCommentThread(projectId, KEY)).toMatchObject({ closed_at: null })

    const listing = await methods.listComments(user.workspaceId, projectId, { status: 'pending' })
    expect(listing.total).toBe(1)
    const pendingId = listing.comments[0]!.id as string

    const approved = await methods.updateCommentStatus(pendingId, 'approved', user.userId)
    expect(approved.status).toBe('approved')
    expect(approved.moderated_by).toBe(user.userId)
    expect(approved.moderated_at).not.toBeNull()

    const counts = await methods.countCommentsByStatus(projectId, 'posts')
    expect(counts).toEqual({ pending: 0, approved: 3, spam: 0, rejected: 0 })

    const bulk = await methods.bulkUpdateComments([pendingId], 'spam', user.userId, { workspaceId: user.workspaceId, projectId })
    expect(bulk).toBe(1)
    expect((await methods.getComment(pendingId))!.status).toBe('spam')
  })

  it('moderator reply is a direct insert and the trigger chains it; deleting a parent cascades', async () => {
    const roots = await methods.listPublicComments(projectId, KEY, { limit: 10 })
    const rootId = roots.roots[0]!.id as string

    const reply = await methods.createComment({
      ...base({ author_name: 'Moderator', body: 'thanks!' }),
      parent_id: rootId,
      author_user_id: user.userId,
      status: 'approved',
      source: 'studio',
    })
    expect(reply.depth).toBe(1)
    expect(reply.root_id).toBe(rootId)

    // Parent on a different entry is refused by the trigger.
    await expect(methods.createComment({
      ...base({ entry_id: 'entry-other', body: 'wrong' }),
      parent_id: rootId,
    })).rejects.toThrow()

    await methods.deleteComment(rootId)
    expect(await methods.getComment(rootId)).toBeNull()
    expect(await methods.getComment(reply.id as string)).toBeNull()
  })

  it('import: zero record loss, parents linked out of order and across chunks, re-run idempotent, closed threads kept', async () => {
    const importKey = { model_id: 'posts', entry_id: 'entry-import', locale: 'en' }
    const row = (over: Partial<CommentImportRow>): CommentImportRow => ({
      source_id: '0',
      source_parent_id: null,
      ...importKey,
      author_name: 'WP',
      author_email: null,
      author_url: null,
      body: 'imported',
      status: 'approved',
      type: 'comment',
      created_at: '2019-03-01T00:00:00.000Z',
      ...over,
    })

    // Chunk 1: children arrive BEFORE their parents (ids 3 → 2 → 1), plus one whose parent is in chunk 2.
    const chunk1 = [
      row({ source_id: '3', source_parent_id: '2', created_at: '2019-03-03T00:00:00.000Z' }),
      row({ source_id: '2', source_parent_id: '1', created_at: '2019-03-02T00:00:00.000Z' }),
      row({ source_id: '1' }),
      row({ source_id: '20', source_parent_id: '10', created_at: '2019-04-02T00:00:00.000Z', status: 'pending' }),
    ]
    const first = await methods.importComments(projectId, user.workspaceId, { comments: chunk1, threads_closed: [importKey] })
    expect(first.inserted).toBe(4)
    expect(first.skippedExisting).toBe(0)
    expect(first.orphanCount).toBe(1)
    expect(first.orphanParents).toEqual([{ source_id: '20', source_parent_id: '10' }])
    expect(first.maxDepth).toBe(2)
    expect(first.threadsClosed).toBe(1)
    expect((await methods.getCommentThread(projectId, importKey))!.closed_at).not.toBeNull()

    // Chunk 2 brings the missing parent; re-sends one duplicate.
    const chunk2 = [
      row({ source_id: '10', created_at: '2019-04-01T00:00:00.000Z' }),
      row({ source_id: '1' }),
    ]
    const second = await methods.importComments(projectId, user.workspaceId, { comments: chunk2, threads_closed: [] })
    expect(second.inserted).toBe(1)
    expect(second.skippedExisting).toBe(1)
    expect(second.orphanCount).toBe(0)

    const all = await methods.listComments(user.workspaceId, projectId, { entryId: 'entry-import', limit: 100, sort: 'oldest' })
    expect(all.total).toBe(5)
    const bySource = new Map(all.comments.map(c => [c.source_id as string, c]))
    expect(bySource.get('1')!.depth).toBe(0)
    expect(bySource.get('2')!.parent_id).toBe(bySource.get('1')!.id)
    expect(bySource.get('2')!.depth).toBe(1)
    expect(bySource.get('3')!.parent_id).toBe(bySource.get('2')!.id)
    expect(bySource.get('3')!.depth).toBe(2)
    expect(bySource.get('3')!.root_id).toBe(bySource.get('1')!.id)
    expect(bySource.get('20')!.parent_id).toBe(bySource.get('10')!.id)
    expect(bySource.get('20')!.root_id).toBe(bySource.get('10')!.id)
    // Source timestamps preserved, not import time.
    expect(new Date(bySource.get('1')!.created_at as string).toISOString()).toBe('2019-03-01T00:00:00.000Z')
    for (const c of all.comments) expect(c.source).toBe('import')

    // Imports never count against the monthly quota (only the surviving web comment does:
    // the root + its reply were deleted in the cascade test above).
    expect(await methods.countMonthlyComments(user.workspaceId)).toBe(1)

    // Public read of the imported thread: pending child (20) hidden, chain intact.
    const pub = await methods.listPublicComments(projectId, importKey, { limit: 10 })
    expect(pub.roots.map(r => r.source_id)).toEqual(['1', '10'])
    expect(pub.replies.map(r => r.source_id)).toEqual(['2', '3'])
  })
})

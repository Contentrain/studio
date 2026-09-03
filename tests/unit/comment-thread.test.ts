import { COMMENTS_EXPORT_FORMAT } from '@contentrain/types'
import type { CommentsExport } from '@contentrain/types'
import { describe, expect, it } from 'vitest'
import {
  buildCommentTree,
  mapCommentsExport,
  mapWordPressStatus,
  normalizeCommentType,
  toPublicComment,
  validateCommentsExport,
} from '../../server/utils/comment-thread'

function row(overrides: Record<string, unknown>) {
  return {
    id: 'c1',
    parent_id: null,
    root_id: 'c1',
    depth: 0,
    author_name: 'Ada',
    author_email: 'ada@example.com',
    author_url: null,
    author_user_id: null,
    body: 'hello',
    type: 'comment',
    source: 'web',
    source_ip: '203.0.113.9',
    user_agent: 'ua',
    referrer: 'https://example.com',
    created_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

describe('toPublicComment', () => {
  it('exposes author name/url and body but never email, ip, user agent or referrer', () => {
    const pub = toPublicComment(row({ author_url: 'https://ada.dev' }))
    expect(pub).toEqual({
      id: 'c1',
      parentId: null,
      depth: 0,
      author: { name: 'Ada', url: 'https://ada.dev', isModerator: false },
      body: 'hello',
      type: 'comment',
      createdAt: '2026-01-01T00:00:00.000Z',
      replies: [],
    })
    expect(JSON.stringify(pub)).not.toContain('ada@example.com')
    expect(JSON.stringify(pub)).not.toContain('203.0.113.9')
  })

  it('flags Studio-authored rows as moderator', () => {
    expect(toPublicComment(row({ source: 'studio' })).author.isModerator).toBe(true)
    expect(toPublicComment(row({ author_user_id: 'u1' })).author.isModerator).toBe(true)
  })
})

describe('buildCommentTree', () => {
  it('nests replies under their parents in created_at order and keeps root order', () => {
    const roots = [row({ id: 'r2', root_id: 'r2', created_at: '2026-01-02T00:00:00.000Z' }), row({ id: 'r1', root_id: 'r1' })]
    const replies = [
      row({ id: 'a2', parent_id: 'r1', root_id: 'r1', depth: 1, created_at: '2026-01-01T02:00:00.000Z' }),
      row({ id: 'a1', parent_id: 'r1', root_id: 'r1', depth: 1, created_at: '2026-01-01T01:00:00.000Z' }),
      row({ id: 'b1', parent_id: 'a1', root_id: 'r1', depth: 2, created_at: '2026-01-01T03:00:00.000Z' }),
    ]

    const { threads, dropped } = buildCommentTree(roots, replies)

    expect(dropped).toBe(0)
    expect(threads.map(t => t.id)).toEqual(['r2', 'r1'])
    const r1 = threads[1]!
    expect(r1.replies.map(r => r.id)).toEqual(['a1', 'a2'])
    expect(r1.replies[0]!.replies.map(r => r.id)).toEqual(['b1'])
  })

  it('drops a reply whose parent is not in the visible set (moderated-out branch stays hidden)', () => {
    const roots = [row({ id: 'r1' })]
    const replies = [row({ id: 'x', parent_id: 'gone', root_id: 'r1', depth: 1 })]
    const { threads, dropped } = buildCommentTree(roots, replies)
    expect(dropped).toBe(1)
    expect(threads[0]!.replies).toEqual([])
  })
})

describe('WordPress mapping', () => {
  it('maps the approved vocabulary and keeps unknown values as pending', () => {
    expect(mapWordPressStatus('1')).toBe('approved')
    expect(mapWordPressStatus('0')).toBe('pending')
    expect(mapWordPressStatus('spam')).toBe('spam')
    expect(mapWordPressStatus('trash')).toBe('rejected')
    expect(mapWordPressStatus('post-trashed')).toBe('pending')
    expect(mapWordPressStatus(undefined)).toBe('pending')
  })

  it('normalizes comment types', () => {
    expect(normalizeCommentType('pingback')).toBe('pingback')
    expect(normalizeCommentType('trackback')).toBe('trackback')
    expect(normalizeCommentType('comment')).toBe('comment')
    expect(normalizeCommentType('')).toBe('comment')
    expect(normalizeCommentType(undefined)).toBe('comment')
  })
})

function makeExport(overrides: Partial<CommentsExport> = {}): CommentsExport {
  return {
    version: 1,
    format: COMMENTS_EXPORT_FORMAT,
    source: { kind: 'wxr', extracted_at: '2026-01-10T00:00:00.000Z' } as unknown as CommentsExport['source'],
    site_url: 'https://blog.example',
    generated_at: '2026-01-10T00:00:00.000Z',
    entries: {
      10: { model_id: 'posts', entry_id: 'e10' },
      11: { model_id: 'posts', entry_id: 'e11', locale: 'tr' },
    },
    threads_closed: [11, 999],
    comments: [
      { id: 1, post: 10, parent: null, author: 'Ada', email: 'ada@example.com', url: 'https://ada.dev', date: '2020-05-01T10:00:00Z', content: '<p>First!</p>', approved: '1', type: 'comment' },
      { id: 2, post: 10, parent: 1, author: '<b>Bob</b>', email: null, url: null, date: null, date_gmt: '2020-05-02 11:00:00', content: 'Reply<br>line two', approved: '0', type: 'comment' },
      { id: 3, post: 11, parent: null, author: '', email: null, url: 'javascript:alert(1)', date: 'not a date', content: '', approved: 'spam', type: 'pingback' },
      { id: 4, post: 999, parent: null, author: 'Nobody', email: null, url: null, date: null, content: 'orphan post', approved: '1' },
    ],
    ...overrides,
  }
}

describe('validateCommentsExport', () => {
  it('accepts a well-formed export', () => {
    expect(validateCommentsExport(makeExport(), 5000)).toBeNull()
  })

  it('rejects the wrong format, bad entries and oversize payloads', () => {
    expect(validateCommentsExport(null, 10)?.code).toBe('invalid_payload')
    expect(validateCommentsExport({ ...makeExport(), format: 'nope' }, 10)?.code).toBe('unsupported_format')
    expect(validateCommentsExport({ ...makeExport(), entries: [] }, 10)?.code).toBe('invalid_entries')
    expect(validateCommentsExport({ ...makeExport(), entries: { 10: { model_id: 'posts' } } }, 10)?.code).toBe('invalid_entries')
    expect(validateCommentsExport(makeExport(), 2)?.code).toBe('too_many_comments')
  })
})

describe('mapCommentsExport', () => {
  it('maps every comment with an entry, preserves source ids/parents/dates, and reports the rest', () => {
    const mapped = mapCommentsExport(makeExport(), 'en')

    expect(mapped.rows.map(r => r.source_id)).toEqual(['1', '2', '3'])
    expect(mapped.unmapped).toEqual([{ comment_id: 4, post: 999 }])

    const [first, reply, ping] = mapped.rows
    expect(first).toMatchObject({
      source_parent_id: null,
      model_id: 'posts',
      entry_id: 'e10',
      locale: 'en',
      author_name: 'Ada',
      author_email: 'ada@example.com',
      author_url: 'https://ada.dev/',
      body: 'First!',
      status: 'approved',
      type: 'comment',
      created_at: '2020-05-01T10:00:00.000Z',
    })
    expect(reply).toMatchObject({
      source_parent_id: '1',
      author_name: 'Bob',
      body: 'Reply\nline two',
      status: 'pending',
    })
    // date_gmt is used when date is null
    expect(reply!.created_at).toBe(new Date('2020-05-02 11:00:00').toISOString())
    expect(ping).toMatchObject({
      entry_id: 'e11',
      locale: 'tr',
      author_name: 'Anonymous',
      author_url: null, // javascript: stripped → empty → null
      status: 'spam',
      type: 'pingback',
    })
    // empty body never drops the record
    expect(ping!.body.length).toBeGreaterThan(0)
    // unparseable date → export's generated_at, counted
    expect(ping!.created_at).toBe('2026-01-10T00:00:00.000Z')
    expect(mapped.datesDefaulted).toBe(1)
  })

  it('maps threads_closed through the entry map and ignores unknown posts', () => {
    const mapped = mapCommentsExport(makeExport(), 'en')
    expect(mapped.threadsClosed).toEqual([{ model_id: 'posts', entry_id: 'e11', locale: 'tr' }])
  })
})

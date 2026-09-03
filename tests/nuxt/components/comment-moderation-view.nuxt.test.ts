import { describe, expect, it, vi } from 'vitest'
import { mockNuxtImport, mountSuspended, registerEndpoint } from '@nuxt/test-utils/runtime'
import CommentModerationView from '../../../app/components/organisms/CommentModerationView.vue'

mockNuxtImport('useToast', () => () => ({ success: vi.fn(), error: vi.fn() }))

const comment = (overrides: Record<string, unknown>) => ({
  id: 'c-1',
  project_id: 'p-1',
  workspace_id: 'ws-1',
  model_id: 'posts',
  entry_id: 'hello-world',
  locale: 'en',
  parent_id: null,
  root_id: 'c-1',
  depth: 0,
  author_name: 'Ada Lovelace',
  author_email: 'ada@example.com',
  author_url: null,
  author_user_id: null,
  body: 'What a lovely post — thank you for writing it.',
  status: 'pending',
  type: 'comment',
  source: 'web',
  source_id: null,
  source_ip: '203.0.113.9',
  user_agent: null,
  referrer: null,
  moderated_at: null,
  moderated_by: null,
  created_at: new Date(Date.now() - 5 * 60_000).toISOString(),
  updated_at: new Date().toISOString(),
  ...overrides,
})

registerEndpoint('/api/workspaces/ws-1/projects/p-1/comments', () => ({
  comments: [
    comment({}),
    comment({ id: 'c-2', author_name: 'Grace Hopper', body: 'Replying as staff', source: 'studio', status: 'approved', depth: 1, parent_id: 'c-1' }),
  ],
  total: 2,
  counts: { pending: 1, approved: 1, spam: 0, rejected: 3 },
}))

registerEndpoint('/api/workspaces/ws-empty/projects/p-1/comments', () => ({
  comments: [],
  total: 0,
  counts: { pending: 0, approved: 0, spam: 0, rejected: 0 },
}))

describe('CommentModerationView', () => {
  it('renders the status filters with counts and one row per comment', async () => {
    const wrapper = await mountSuspended(CommentModerationView, {
      props: { workspaceId: 'ws-1', projectId: 'p-1', modelId: 'posts', editable: true },
    })
    await new Promise(resolve => setTimeout(resolve, 10))

    const text = wrapper.text()
    expect(text).toContain('Ada Lovelace')
    expect(text).toContain('What a lovely post')
    expect(text).toContain('Grace Hopper')
    // Staff replies are labelled so a moderator can tell them from visitor comments.
    expect(text).toContain('Moderator')
    // Filter chips carry the server-side counts, including the tab that is not active.
    expect(text).toContain('Rejected')
    expect(text).toContain('3')
    expect(text).toContain('hello-world')
    // Visitor PII stays out of the list; it belongs to the detail modal only.
    expect(text).not.toContain('ada@example.com')
    expect(text).not.toContain('203.0.113.9')
  })

  it('offers approve / spam / reject on a pending row for an editor', async () => {
    const wrapper = await mountSuspended(CommentModerationView, {
      props: { workspaceId: 'ws-1', projectId: 'p-1', modelId: 'posts', editable: true },
    })
    await new Promise(resolve => setTimeout(resolve, 10))

    const labels = wrapper.findAll('button').map(b => b.attributes('aria-label') ?? b.text())
    expect(labels).toContain('Approve')
    expect(labels).toContain('Spam')
    expect(labels).toContain('Reject')
  })

  it('shows the empty state without any moderation controls for a read-only member', async () => {
    const wrapper = await mountSuspended(CommentModerationView, {
      props: { workspaceId: 'ws-empty', projectId: 'p-1', modelId: 'posts', editable: false },
    })
    await new Promise(resolve => setTimeout(resolve, 10))

    expect(wrapper.text()).toContain('No comments yet')
    const labels = wrapper.findAll('button').map(b => b.attributes('aria-label') ?? b.text())
    expect(labels).not.toContain('Approve')
  })
})

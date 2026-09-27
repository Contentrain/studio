import { describe, expect, it, vi } from 'vitest'
import type { ApprovalPolicyFile } from '@contentrain/types'
import { withTestServer } from '../helpers/http'
import { resolveContentPath } from '../../server/utils/content-paths'

async function loadContentPostHandler() {
  return (await import('../../server/api/workspaces/[workspaceId]/projects/[projectId]/content/[modelId].post')).default
}

async function loadContentStatusHandler() {
  return (await import('../../server/api/workspaces/[workspaceId]/projects/[projectId]/content/[modelId]/status.patch')).default
}

describe('content route integration', () => {
  it('saves content only for users with save_content permission and tracks media usage non-fatally', async () => {
    const mergeBranch = vi.fn().mockResolvedValue({ merged: true, sha: 'merge-sha', pullRequestUrl: null })
    const saveContent = vi.fn().mockResolvedValue({
      branch: 'cr/content/posts/en/1234567890-abcd',
      commit: { sha: 'abc' },
      diff: [],
      validation: { valid: true, errors: [] },
    })
    // Usage tracking resolves assets by storage path now — the filename
    // `search` lookup never matched (the path uuid names the file, while
    // `search` only covers filename/alt).
    const getAssetByPath = vi.fn().mockResolvedValue({ id: 'asset-1' })
    const trackMediaUsage = vi.fn().mockResolvedValue(undefined)

    vi.stubGlobal('getRouterParam', vi.fn((_: unknown, key: string) => {
      if (key === 'workspaceId') return 'workspace-1'
      if (key === 'projectId') return 'project-1'
      if (key === 'modelId') return 'posts'
      return undefined
    }))
    vi.stubGlobal('requireAuth', vi.fn().mockReturnValue({
      user: { id: 'editor-1', email: 'editor@example.com' },
      accessToken: 'token-1',
    }))
    vi.stubGlobal('resolveAgentPermissions', vi.fn().mockResolvedValue({
      workspaceRole: 'editor',
      availableTools: ['save_content'],
      specificModels: false,
      allowedModels: [],
    }))
    vi.stubGlobal('useSupabaseUserClient', vi.fn().mockReturnValue({}))
    vi.stubGlobal('resolveProjectContext', vi.fn().mockResolvedValue({
      git: {},
      contentRoot: '',
      workspace: { plan: 'starter' },
    }))
    vi.stubGlobal('getWorkspacePlan', vi.fn().mockReturnValue('starter'))
    vi.stubGlobal('hasFeature', vi.fn().mockReturnValue(false))
    vi.stubGlobal('getOrBuildBrainCache', vi.fn().mockResolvedValue({
      config: { workflow: 'auto-merge' },
      models: new Map([['posts', { id: 'posts', kind: 'collection' }]]),
    }))
    vi.stubGlobal('invalidateBrainCache', vi.fn())
    vi.stubGlobal('createContentEngine', vi.fn().mockReturnValue({ saveContent, mergeBranch }))
    vi.stubGlobal('useMediaProvider', vi.fn().mockReturnValue({ getAssetByPath }))
    vi.stubGlobal('emitWebhookEvent', vi.fn().mockResolvedValue(undefined))
    vi.stubGlobal('useDatabaseProvider', vi.fn().mockReturnValue({
      trackMediaUsage,
    }))

    await withTestServer({
      routes: [
        { path: '/api/workspaces/workspace-1/projects/project-1/content/posts', handler: await loadContentPostHandler() },
      ],
    }, async ({ request }) => {
      const response = await request('/api/workspaces/workspace-1/projects/project-1/content/posts', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          locale: 'en',
          data: {
            entry1: {
              title: 'Hello world',
              heroImage: 'media/hero.png',
            },
          },
        }),
      })

      expect(response.status).toBe(200)
      const payload = await response.json()
      expect(payload.branch).toBe('cr/content/posts/en/1234567890-abcd')
      expect(payload.merged).toBe(true)
      expect(payload.workflow).toBe('auto-merge')
      expect(saveContent).toHaveBeenCalledWith('posts', 'en', {
        entry1: {
          title: 'Hello world',
          heroImage: 'media/hero.png',
        },
      }, 'editor@example.com')
      expect(mergeBranch).toHaveBeenCalledWith('cr/content/posts/en/1234567890-abcd')
      expect(trackMediaUsage).toHaveBeenCalledWith({
        asset_id: 'asset-1',
        project_id: 'project-1',
        model_id: 'posts',
        entry_id: 'entry1',
        field_id: 'heroImage',
        locale: 'en',
      })
    })
  })

  // The route counts entries by the model's kind, the way approve/merge reads
  // the branch: a singleton's fields are one record, not one entry each.
  it.each([
    { name: 'one collection entry', modelId: 'posts', kind: 'collection', data: { entry1: { title: 'Hello world' } }, risk: 'low_risk_content' },
    { name: 'a three-field singleton', modelId: 'site', kind: 'singleton', data: { title: 'Hi', tagline: 'Short', cta: 'Go' }, risk: 'low_risk_content' },
    { name: 'two collection entries', modelId: 'posts', kind: 'collection', data: { a: { title: 'A' }, b: { title: 'B' } }, risk: 'bulk_content' },
  ])('holds an owner\'s editor save on a review project and says what it is waiting for ($name)', async ({ modelId, kind, data, risk }) => {
    // Same gate as the chat handler: the role of whoever saved is not the
    // question any more, so an owner is held by the policy like anyone else.
    const mergeBranch = vi.fn().mockResolvedValue({ merged: true, sha: 'merge-sha', pullRequestUrl: null })
    const saveContent = vi.fn().mockResolvedValue({
      branch: 'cr/content/posts/en/1234567890-abcd',
      commit: { sha: 'abc' },
      diff: [],
      validation: { valid: true, errors: [] },
    })

    vi.stubGlobal('getRouterParam', vi.fn((_: unknown, key: string) => {
      if (key === 'workspaceId') return 'workspace-1'
      if (key === 'projectId') return 'project-1'
      if (key === 'modelId') return modelId
      return undefined
    }))
    vi.stubGlobal('requireAuth', vi.fn().mockReturnValue({
      user: { id: 'owner-1', email: 'owner@example.com' },
      accessToken: 'token-1',
    }))
    vi.stubGlobal('resolveAgentPermissions', vi.fn().mockResolvedValue({
      workspaceRole: 'owner',
      availableTools: ['save_content'],
      specificModels: false,
      allowedModels: [],
    }))
    vi.stubGlobal('useSupabaseUserClient', vi.fn().mockReturnValue({}))
    vi.stubGlobal('resolveProjectContext', vi.fn().mockResolvedValue({
      // The written branch reads back with nothing emptied.
      git: { getBranchDiff: vi.fn().mockResolvedValue([]), readFile: vi.fn() },
      contentRoot: '',
      workspace: { plan: 'pro' },
    }))
    vi.stubGlobal('getWorkspacePlan', vi.fn().mockReturnValue('pro'))
    vi.stubGlobal('hasFeature', vi.fn().mockReturnValue(true))
    // No policy file — the ecosystem default asks for one review.
    vi.stubGlobal('getOrBuildBrainCache', vi.fn().mockResolvedValue({
      config: { workflow: 'review' },
      approvalPolicy: null,
      models: new Map([[modelId, { id: modelId, kind }]]),
    }))
    vi.stubGlobal('invalidateBrainCache', vi.fn())
    vi.stubGlobal('createContentEngine', vi.fn().mockReturnValue({ saveContent, mergeBranch }))
    vi.stubGlobal('useMediaProvider', vi.fn().mockReturnValue(null))
    vi.stubGlobal('emitWebhookEvent', vi.fn().mockResolvedValue(undefined))
    vi.stubGlobal('useDatabaseProvider', vi.fn().mockReturnValue({ trackMediaUsage: vi.fn() }))

    await withTestServer({
      routes: [
        { path: `/api/workspaces/workspace-1/projects/project-1/content/${modelId}`, handler: await loadContentPostHandler() },
      ],
    }, async ({ request }) => {
      const response = await request(`/api/workspaces/workspace-1/projects/project-1/content/${modelId}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ locale: 'en', data }),
      })

      expect(response.status).toBe(200)
      const payload = await response.json()
      expect(payload.merged).toBe(false)
      expect(payload.workflow).toBe('review')
      expect(payload.approval.risk).toBe(risk)
      expect(payload.approval.reasons.length).toBeGreaterThan(0)
      expect(mergeBranch).not.toHaveBeenCalled()
    })
  })

  // Whether a write empties a field is read off the branch it wrote, and the
  // merge reads the same branch the same way — so a project that trusts
  // content edits holds this save, and holds it again at the Merge button.
  it('holds an editor save that empties a nested sub-field, at save and again at merge', async () => {
    const autoLow: ApprovalPolicyFile = {
      version: 1,
      rules: [
        { risk: 'low_risk_content', gate: 'change', mode: 'auto' },
        { risk: 'bulk_content', gate: 'change', mode: 'single' },
      ],
    }
    const posts = { id: 'posts', name: 'Posts', kind: 'collection', domain: 'blog', i18n: true, fields: { title: { type: 'string' }, seo: { type: 'object' } } }
    const branch = 'cr/content/posts/en/1234567890-abcd'
    const path = resolveContentPath({ contentRoot: '' }, posts as never, 'en')
    const files: Record<string, unknown> = {
      contentrain: { entry1: { title: 'Hello', seo: { title: 'Hello', description: 'A post' } } },
      [branch]: { entry1: { title: 'Hello', seo: { title: 'Hello', description: '' } } },
    }
    const git = {
      getBranchDiff: vi.fn().mockResolvedValue([{ path, status: 'modified' }]),
      readFile: vi.fn(async (file: string, ref: string) => {
        if (file !== path) throw new Error('not found')
        return JSON.stringify(files[ref])
      }),
      listBranches: vi.fn().mockResolvedValue([{ name: branch, sha: 'abc' }]),
    }
    const mergeBranch = vi.fn().mockResolvedValue({ merged: true, sha: 'merge-sha', pullRequestUrl: null })
    const saveContent = vi.fn().mockResolvedValue({ branch, commit: { sha: 'abc' }, diff: [], validation: { valid: true, errors: [] } })
    const brain = {
      config: { workflow: 'review', locales: { default: 'en', supported: ['en'] } },
      approvalPolicy: autoLow,
      models: new Map([['posts', posts]]),
      content: new Map(),
    }

    vi.stubGlobal('getRouterParam', vi.fn((_: unknown, key: string) => {
      if (key === 'workspaceId') return 'workspace-1'
      if (key === 'projectId') return 'project-1'
      if (key === 'modelId') return 'posts'
      return undefined
    }))
    vi.stubGlobal('requireAuth', vi.fn().mockReturnValue({ user: { id: 'owner-1', email: 'owner@example.com' }, accessToken: 'token-1' }))
    vi.stubGlobal('resolveAgentPermissions', vi.fn().mockResolvedValue({ workspaceRole: 'owner', availableTools: ['save_content'], specificModels: false, allowedModels: [] }))
    vi.stubGlobal('resolveProjectContext', vi.fn().mockResolvedValue({ git, contentRoot: '', workspace: { plan: 'pro' } }))
    vi.stubGlobal('getWorkspacePlan', vi.fn().mockReturnValue('pro'))
    vi.stubGlobal('hasFeature', vi.fn().mockReturnValue(true))
    vi.stubGlobal('getOrBuildBrainCache', vi.fn().mockResolvedValue(brain))
    vi.stubGlobal('invalidateBrainCache', vi.fn())
    vi.stubGlobal('createContentEngine', vi.fn().mockReturnValue({ saveContent, mergeBranch }))
    vi.stubGlobal('useMediaProvider', vi.fn().mockReturnValue(null))
    vi.stubGlobal('emitWebhookEvent', vi.fn().mockResolvedValue(undefined))
    vi.stubGlobal('useDatabaseProvider', vi.fn().mockReturnValue({ trackMediaUsage: vi.fn(), listApprovals: vi.fn().mockResolvedValue([]) }))

    await withTestServer({
      routes: [
        { path: '/api/workspaces/workspace-1/projects/project-1/content/posts', handler: await loadContentPostHandler() },
      ],
    }, async ({ request }) => {
      const response = await request('/api/workspaces/workspace-1/projects/project-1/content/posts', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ locale: 'en', data: { entry1: { title: 'Hello', seo: { title: 'Hello', description: '' } } } }),
      })

      expect(response.status).toBe(200)
      const payload = await response.json()
      expect(payload.merged).toBe(false)
      expect(payload.approval.risk).toBe('bulk_content')
      expect(payload.approval.reasons[0]).toContain('empties 1 field')
      expect(mergeBranch).not.toHaveBeenCalled()
    })

    const { resolveMergeApproval } = await import('../../server/utils/branch-approval')
    const atMerge = await resolveMergeApproval({ git: git as never, contentRoot: '', projectId: 'project-1', branch, workflow: 'review', policy: autoLow })
    expect(atMerge?.plan.risk).toBe('bulk_content')
    expect(atMerge?.decision.allowed).toBe(false)
  })

  it('only allows workspace owner/admin to publish content statuses', async () => {
    vi.stubGlobal('getRouterParam', vi.fn((_: unknown, key: string) => {
      if (key === 'workspaceId') return 'workspace-1'
      if (key === 'projectId') return 'project-1'
      if (key === 'modelId') return 'posts'
      return undefined
    }))
    vi.stubGlobal('requireAuth', vi.fn().mockReturnValue({
      user: { id: 'editor-1', email: 'editor@example.com' },
      accessToken: 'token-1',
    }))
    vi.stubGlobal('resolveAgentPermissions', vi.fn().mockResolvedValue({
      workspaceRole: 'member',
      availableTools: ['save_content'],
      specificModels: false,
      allowedModels: [],
    }))

    await withTestServer({
      routes: [
        { path: '/api/workspaces/workspace-1/projects/project-1/content/posts/status', handler: await loadContentStatusHandler() },
      ],
    }, async ({ request }) => {
      const response = await request('/api/workspaces/workspace-1/projects/project-1/content/posts/status', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          entryIds: ['entry1'],
          status: 'published',
        }),
      })

      expect(response.status).toBe(403)
      await expect(response.json()).resolves.toMatchObject({
        statusCode: 403,
      })
    })
  })

  it('updates entry statuses and auto-merges the generated branch', async () => {
    const updateEntryStatus = vi.fn().mockResolvedValue({
      branch: 'cr/content/posts/en/1234567890-efgh',
    })
    const mergeBranch = vi.fn().mockResolvedValue({ merged: true })

    vi.stubGlobal('getRouterParam', vi.fn((_: unknown, key: string) => {
      if (key === 'workspaceId') return 'workspace-1'
      if (key === 'projectId') return 'project-1'
      if (key === 'modelId') return 'posts'
      return undefined
    }))
    vi.stubGlobal('requireAuth', vi.fn().mockReturnValue({
      user: { id: 'owner-1', email: 'owner@example.com' },
      accessToken: 'token-1',
    }))
    vi.stubGlobal('resolveAgentPermissions', vi.fn().mockResolvedValue({
      workspaceRole: 'owner',
      availableTools: ['save_content'],
      specificModels: false,
      allowedModels: [],
    }))
    vi.stubGlobal('useSupabaseUserClient', vi.fn().mockReturnValue({}))
    vi.stubGlobal('resolveProjectContext', vi.fn().mockResolvedValue({
      git: {},
      contentRoot: '',
      workspace: { plan: 'starter' },
    }))
    vi.stubGlobal('getWorkspacePlan', vi.fn().mockReturnValue('starter'))
    vi.stubGlobal('hasFeature', vi.fn().mockReturnValue(false))
    vi.stubGlobal('getOrBuildBrainCache', vi.fn().mockResolvedValue({ config: { workflow: 'auto-merge' } }))
    vi.stubGlobal('invalidateBrainCache', vi.fn())
    vi.stubGlobal('createContentEngine', vi.fn().mockReturnValue({
      updateEntryStatus,
      mergeBranch,
    }))

    await withTestServer({
      routes: [
        { path: '/api/workspaces/workspace-1/projects/project-1/content/posts/status', handler: await loadContentStatusHandler() },
      ],
    }, async ({ request }) => {
      const response = await request('/api/workspaces/workspace-1/projects/project-1/content/posts/status', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          locale: 'en',
          entryIds: ['entry1'],
          status: 'published',
        }),
      })

      expect(response.status).toBe(200)
      await expect(response.json()).resolves.toEqual({
        merged: true,
        workflow: 'auto-merge',
        status: 'published',
        entryIds: ['entry1'],
      })
      expect(updateEntryStatus).toHaveBeenCalledWith('posts', 'en', ['entry1'], 'published', 'owner@example.com')
      expect(mergeBranch).toHaveBeenCalledWith('cr/content/posts/en/1234567890-efgh')
    })
  })
  it('holds a status change on a review project instead of merging it past the policy', async () => {
    // A project that trusts one-entry content edits: before the gate, the picker
    // merged every status change whatever the policy said.
    const policy = {
      version: 1,
      default_mode: 'single',
      rules: [{ risk: 'low_risk_content', gate: 'change', mode: 'auto' }],
    }
    const mergeBranch = vi.fn().mockResolvedValue({ merged: true })
    const updateEntryStatus = vi.fn().mockResolvedValue({
      branch: 'cr/content/posts/en/1234567890-ijkl',
      commit: { sha: 'status-sha' },
    })

    vi.stubGlobal('getRouterParam', vi.fn((_: unknown, key: string) => {
      if (key === 'workspaceId') return 'workspace-1'
      if (key === 'projectId') return 'project-1'
      if (key === 'modelId') return 'posts'
      return undefined
    }))
    vi.stubGlobal('useSupabaseUserClient', vi.fn().mockReturnValue({}))
    vi.stubGlobal('resolveProjectContext', vi.fn().mockResolvedValue({ git: {}, contentRoot: '', workspace: { plan: 'pro' } }))
    vi.stubGlobal('getWorkspacePlan', vi.fn().mockReturnValue('pro'))
    vi.stubGlobal('hasFeature', vi.fn().mockReturnValue(true))
    vi.stubGlobal('getOrBuildBrainCache', vi.fn().mockResolvedValue({ config: { workflow: 'review' }, approvalPolicy: policy }))
    vi.stubGlobal('invalidateBrainCache', vi.fn())
    vi.stubGlobal('createContentEngine', vi.fn().mockReturnValue({ updateEntryStatus, mergeBranch }))

    const cases = [
      { role: 'editor', status: 'archived', held: true },
      { role: 'owner', status: 'published', held: true },
      { role: 'editor', status: 'draft', held: false },
    ] as const

    for (const c of cases) {
      mergeBranch.mockClear()
      vi.stubGlobal('requireAuth', vi.fn().mockReturnValue({ user: { id: `${c.role}-1`, email: `${c.role}@example.com` }, accessToken: 'token-1' }))
      vi.stubGlobal('resolveAgentPermissions', vi.fn().mockResolvedValue({
        workspaceRole: c.role,
        availableTools: ['save_content'],
        specificModels: false,
        allowedModels: [],
      }))

      await withTestServer({
        routes: [
          { path: '/api/workspaces/workspace-1/projects/project-1/content/posts/status', handler: await loadContentStatusHandler() },
        ],
      }, async ({ request }) => {
        const response = await request('/api/workspaces/workspace-1/projects/project-1/content/posts/status', {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ locale: 'en', entryIds: ['entry1'], status: c.status }),
        })

        expect(response.status).toBe(200)
        const payload = await response.json()
        if (c.held) {
          expect(payload.merged).toBe(false)
          expect(payload.branch).toBe('cr/content/posts/en/1234567890-ijkl')
          expect(payload.approval.risk).toBe('bulk_content')
          expect(payload.approval.reasons[0]).toContain(`\`${c.status}\``)
          expect(mergeBranch).not.toHaveBeenCalled()
        }
        else {
          expect(payload.merged).toBe(true)
          expect(mergeBranch).toHaveBeenCalledWith('cr/content/posts/en/1234567890-ijkl')
        }
      })
    }
  })
})

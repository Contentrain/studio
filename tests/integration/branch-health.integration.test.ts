import { describe, expect, it, vi } from 'vitest'
import { withTestServer } from '../helpers/http'

// ── Handler loaders ───────────────────────────────────

async function loadHealthHandler() {
  return (await import('../../server/api/workspaces/[workspaceId]/projects/[projectId]/branches/health.get')).default
}

async function loadCleanupHandler() {
  return (await import('../../server/api/workspaces/[workspaceId]/projects/[projectId]/branches/cleanup.post')).default
}

// ── Helpers ───────────────────────────────────────────

function stubRouteParams() {
  vi.stubGlobal('getRouterParam', vi.fn((_: unknown, key: string) => {
    if (key === 'workspaceId') return 'workspace-1'
    if (key === 'projectId') return 'project-1'
    return undefined
  }))
}

function stubAuth(userId = 'user-1') {
  vi.stubGlobal('requireAuth', vi.fn().mockReturnValue({
    user: { id: userId, email: 'admin@example.com' },
    accessToken: 'token-1',
  }))
}

function stubGitProvider(overrides: Record<string, unknown> = {}) {
  const git = {
    listBranches: vi.fn().mockResolvedValue([]),
    isMerged: vi.fn().mockResolvedValue(false),
    deleteBranch: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  }
  vi.stubGlobal('resolveProjectContext', vi.fn().mockResolvedValue({
    git,
    contentRoot: '',
    project: { id: 'project-1' },
    workspace: { id: 'workspace-1', github_installation_id: 1 },
  }))
  return git
}

// ── Tests ─────────────────────────────────────────────

describe('branch health API', () => {
  describe('GET /branches/health', () => {
    it('returns health status for a project', async () => {
      stubRouteParams()
      stubAuth()
      stubGitProvider({
        listBranches: vi.fn().mockResolvedValue([
          { name: 'cr/content/a/1-aa', sha: 'sha1', protected: false },
          { name: 'cr/content/b/2-bb', sha: 'sha2', protected: false },
        ]),
        isMerged: vi.fn()
          .mockResolvedValueOnce(true) // a merged
          .mockResolvedValueOnce(false), // b unmerged
      })

      // Stub branch-health functions as globals (Nitro auto-import)
      const { checkBranchHealth, getHealthStatus, clearHealthCache } = await import('../../server/utils/branch-health')
      vi.stubGlobal('checkBranchHealth', checkBranchHealth)
      vi.stubGlobal('getHealthStatus', getHealthStatus)
      clearHealthCache()

      const handler = await loadHealthHandler()

      await withTestServer({
        routes: [
          { path: '/api/workspaces/workspace-1/projects/project-1/branches/health', handler },
        ],
      }, async ({ request }) => {
        const response = await request('/api/workspaces/workspace-1/projects/project-1/branches/health')
        expect(response.status).toBe(200)

        const body = await response.json()
        expect(body.status).toBe('ok')
        expect(body.unmergedCount).toBe(1)
        expect(body.lastChecked).toBeTruthy()
      })
    })

    it('rejects unauthenticated requests', async () => {
      stubRouteParams()
      vi.stubGlobal('requireAuth', vi.fn(() => {
        throw Object.assign(new Error('Unauthorized'), { statusCode: 401 })
      }))

      const handler = await loadHealthHandler()

      await withTestServer({
        routes: [
          { path: '/api/workspaces/workspace-1/projects/project-1/branches/health', handler },
        ],
      }, async ({ request }) => {
        const response = await request('/api/workspaces/workspace-1/projects/project-1/branches/health')
        expect(response.status).toBe(401)
      })
    })
  })

  describe('POST /branches/cleanup', () => {
    it('cleans up merged branches and returns report', async () => {
      stubRouteParams()
      stubAuth()

      const oldTimestamp = Math.floor(Date.now() / 1000) - 40 * 24 * 60 * 60
      const git = stubGitProvider({
        listBranches: vi.fn().mockResolvedValue([
          { name: `cr/content/posts/en/${oldTimestamp}-a1b2`, sha: 'sha1', protected: false },
        ]),
        isMerged: vi.fn().mockResolvedValue(true),
        deleteBranch: vi.fn().mockResolvedValue(undefined),
      })

      vi.stubGlobal('useDatabaseProvider', vi.fn().mockReturnValue({
        requireWorkspaceRole: vi.fn().mockResolvedValue('owner'),
      }))

      const { cleanupMergedBranches, clearHealthCache } = await import('../../server/utils/branch-health')
      vi.stubGlobal('cleanupMergedBranches', cleanupMergedBranches)
      clearHealthCache()

      const handler = await loadCleanupHandler()

      await withTestServer({
        routes: [
          { path: '/api/workspaces/workspace-1/projects/project-1/branches/cleanup', handler },
        ],
      }, async ({ request }) => {
        const response = await request('/api/workspaces/workspace-1/projects/project-1/branches/cleanup', {
          method: 'POST',
        })
        expect(response.status).toBe(200)

        const body = await response.json()
        expect(body.deleted).toHaveLength(1)
        expect(body.remaining).toBe(0)
        expect(body.status).toBe('ok')
      })

      expect(git.deleteBranch).toHaveBeenCalledWith(`cr/content/posts/en/${oldTimestamp}-a1b2`)
    })

    it('rejects non-admin users', async () => {
      stubRouteParams()
      stubAuth()

      vi.stubGlobal('useDatabaseProvider', vi.fn().mockReturnValue({
        requireWorkspaceRole: vi.fn().mockRejectedValue(
          Object.assign(new Error('workspace.admin_required'), { statusCode: 403 }),
        ),
      }))

      const handler = await loadCleanupHandler()

      await withTestServer({
        routes: [
          { path: '/api/workspaces/workspace-1/projects/project-1/branches/cleanup', handler },
        ],
      }, async ({ request }) => {
        const response = await request('/api/workspaces/workspace-1/projects/project-1/branches/cleanup', {
          method: 'POST',
        })
        expect(response.status).toBe(403)
      })
    })

    it('allows admin role', async () => {
      stubRouteParams()
      stubAuth()
      stubGitProvider()

      vi.stubGlobal('useDatabaseProvider', vi.fn().mockReturnValue({
        requireWorkspaceRole: vi.fn().mockResolvedValue('admin'),
      }))

      const { cleanupMergedBranches, clearHealthCache } = await import('../../server/utils/branch-health')
      vi.stubGlobal('cleanupMergedBranches', cleanupMergedBranches)
      clearHealthCache()

      const handler = await loadCleanupHandler()

      await withTestServer({
        routes: [
          { path: '/api/workspaces/workspace-1/projects/project-1/branches/cleanup', handler },
        ],
      }, async ({ request }) => {
        const response = await request('/api/workspaces/workspace-1/projects/project-1/branches/cleanup', {
          method: 'POST',
        })
        expect(response.status).toBe(200)
      })
    })
  })
})

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GitProvider } from '../../server/providers/git'
import {
  calculateStatus,
  checkBranchHealth,
  cleanupMergedBranches,
  clearHealthCache,
  extractBranchTimestamp,
  getHealthStatus,
  setHealthStatus,
  THRESHOLDS,
} from '../../server/utils/branch-health'

function createGitProvider(overrides: Partial<GitProvider> = {}): GitProvider {
  return {
    getTree: vi.fn(),
    readFile: vi.fn(),
    listDirectory: vi.fn().mockResolvedValue([]),
    fileExists: vi.fn(),
    createBranch: vi.fn(),
    listBranches: vi.fn().mockResolvedValue([]),
    getBranchDiff: vi.fn().mockResolvedValue([]),
    mergeBranch: vi.fn().mockResolvedValue({ merged: true, sha: 'sha', pullRequestUrl: null }),
    deleteBranch: vi.fn(),
    commitFiles: vi.fn(),
    createPR: vi.fn(),
    mergePR: vi.fn(),
    getPermissions: vi.fn(),
    getBranchProtection: vi.fn(),
    getDefaultBranch: vi.fn().mockResolvedValue('main'),
    detectFramework: vi.fn(),
    isMerged: vi.fn().mockResolvedValue(false),
    ...overrides,
  } as unknown as GitProvider
}

describe('branch-health', () => {
  beforeEach(() => {
    clearHealthCache()
    vi.stubGlobal('createError', ({ statusCode, message }: { statusCode: number, message: string }) =>
      Object.assign(new Error(message), { statusCode, message }),
    )
    vi.stubGlobal('errorMessage', (key: string) => key)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  // ── calculateStatus ─────────────────────────────────

  describe('calculateStatus', () => {
    it('returns ok for 0 branches', () => {
      expect(calculateStatus(0)).toBe('ok')
    })

    it('returns ok for 49 branches (below warning threshold)', () => {
      expect(calculateStatus(49)).toBe('ok')
    })

    it('returns warning at exactly 50 branches', () => {
      expect(calculateStatus(50)).toBe('warning')
    })

    it('returns warning for 79 branches', () => {
      expect(calculateStatus(79)).toBe('warning')
    })

    it('returns blocked at exactly 80 branches', () => {
      expect(calculateStatus(80)).toBe('blocked')
    })

    it('returns blocked for 200 branches', () => {
      expect(calculateStatus(200)).toBe('blocked')
    })

    it('uses correct threshold constants', () => {
      expect(THRESHOLDS.WARNING).toBe(50)
      expect(THRESHOLDS.BLOCKED).toBe(80)
    })
  })

  // ── extractBranchTimestamp ──────────────────────────

  describe('extractBranchTimestamp', () => {
    it('extracts timestamp from standard branch name', () => {
      expect(extractBranchTimestamp('cr/content/posts/en/1711234567-a1b2')).toBe(1711234567)
    })

    it('extracts timestamp from branch without locale', () => {
      expect(extractBranchTimestamp('cr/model/authors/1711234567-c3d4')).toBe(1711234567)
    })

    it('returns null for empty string', () => {
      expect(extractBranchTimestamp('')).toBeNull()
    })

    it('returns null for branch without timestamp pattern', () => {
      expect(extractBranchTimestamp('cr/content/posts/en/no-timestamp')).toBeNull()
    })

    it('returns null for branch with non-numeric prefix', () => {
      expect(extractBranchTimestamp('cr/content/abc-def')).toBeNull()
    })
  })

  // ── Health cache ────────────────────────────────────

  describe('health cache', () => {
    it('returns undefined for uncached project', () => {
      expect(getHealthStatus('unknown-project')).toBeUndefined()
    })

    it('stores and retrieves health status', () => {
      const report = { status: 'ok' as const, unmergedCount: 5, lastChecked: new Date().toISOString() }
      setHealthStatus('project-1', report)
      expect(getHealthStatus('project-1')).toEqual(report)
    })

    it('returns undefined for expired cache entries', () => {
      const staleDate = new Date(Date.now() - THRESHOLDS.CACHE_TTL_MS - 1000).toISOString()
      setHealthStatus('project-1', { status: 'ok', unmergedCount: 5, lastChecked: staleDate })
      expect(getHealthStatus('project-1')).toBeUndefined()
    })

    it('clears all entries on clearHealthCache', () => {
      setHealthStatus('p1', { status: 'ok', unmergedCount: 0, lastChecked: new Date().toISOString() })
      setHealthStatus('p2', { status: 'warning', unmergedCount: 55, lastChecked: new Date().toISOString() })
      clearHealthCache()
      expect(getHealthStatus('p1')).toBeUndefined()
      expect(getHealthStatus('p2')).toBeUndefined()
    })
  })

  // ── checkBranchHealth ───────────────────────────────

  describe('checkBranchHealth', () => {
    it('reports ok when all branches are merged', async () => {
      const git = createGitProvider({
        listBranches: vi.fn().mockResolvedValue([
          { name: 'cr/content/posts/en/1711234567-a1b2', sha: 'sha1', protected: false },
          { name: 'cr/content/faq/en/1711234568-b2c3', sha: 'sha2', protected: false },
        ]),
        isMerged: vi.fn().mockResolvedValue(true),
      })

      const report = await checkBranchHealth(git, 'project-1')

      expect(report.status).toBe('ok')
      expect(report.unmergedCount).toBe(0)
      expect(report.lastChecked).toBeTruthy()
    })

    it('counts only unmerged branches', async () => {
      const git = createGitProvider({
        listBranches: vi.fn().mockResolvedValue([
          { name: 'cr/content/a/1-aa', sha: 'sha1', protected: false },
          { name: 'cr/content/b/2-bb', sha: 'sha2', protected: false },
          { name: 'cr/content/c/3-cc', sha: 'sha3', protected: false },
        ]),
        isMerged: vi.fn()
          .mockResolvedValueOnce(true) // a is merged
          .mockResolvedValueOnce(false) // b is unmerged
          .mockResolvedValueOnce(false), // c is unmerged
      })

      const report = await checkBranchHealth(git, 'project-1')

      expect(report.unmergedCount).toBe(2)
      expect(report.status).toBe('ok')
    })

    it('returns warning when unmerged count reaches 50', async () => {
      const branches = Array.from({ length: 55 }, (_, i) => ({
        name: `cr/content/model${i}/en/${i}-abcd`,
        sha: `sha-${i}`,
        protected: false,
      }))

      const git = createGitProvider({
        listBranches: vi.fn().mockResolvedValue(branches),
        isMerged: vi.fn().mockResolvedValue(false), // all unmerged
      })

      const report = await checkBranchHealth(git, 'project-1')

      expect(report.status).toBe('warning')
      expect(report.unmergedCount).toBe(55)
    })

    it('returns blocked when unmerged count reaches 80', async () => {
      const branches = Array.from({ length: 85 }, (_, i) => ({
        name: `cr/content/model${i}/en/${i}-abcd`,
        sha: `sha-${i}`,
        protected: false,
      }))

      const git = createGitProvider({
        listBranches: vi.fn().mockResolvedValue(branches),
        isMerged: vi.fn().mockResolvedValue(false),
      })

      const report = await checkBranchHealth(git, 'project-1')

      expect(report.status).toBe('blocked')
      expect(report.unmergedCount).toBe(85)
    })

    it('caches the result after check', async () => {
      const git = createGitProvider({
        listBranches: vi.fn().mockResolvedValue([]),
        isMerged: vi.fn(),
      })

      await checkBranchHealth(git, 'project-1')

      const cached = getHealthStatus('project-1')
      expect(cached).toBeDefined()
      expect(cached!.status).toBe('ok')
      expect(cached!.unmergedCount).toBe(0)
    })
  })

  // ── cleanupMergedBranches ───────────────────────────

  describe('cleanupMergedBranches', () => {
    it('deletes merged branches past retention period', async () => {
      const oldTimestamp = Math.floor(Date.now() / 1000) - 40 * 24 * 60 * 60 // 40 days ago
      const deleteBranch = vi.fn().mockResolvedValue(undefined)

      const git = createGitProvider({
        listBranches: vi.fn().mockResolvedValue([
          { name: `cr/content/posts/en/${oldTimestamp}-a1b2`, sha: 'sha1', protected: false },
        ]),
        isMerged: vi.fn().mockResolvedValue(true),
        deleteBranch,
      })

      const report = await cleanupMergedBranches(git, 'project-1')

      expect(deleteBranch).toHaveBeenCalledWith(`cr/content/posts/en/${oldTimestamp}-a1b2`)
      expect(report.deleted).toHaveLength(1)
      expect(report.remaining).toBe(0)
    })

    it('preserves merged branches within retention period', async () => {
      const recentTimestamp = Math.floor(Date.now() / 1000) - 5 * 24 * 60 * 60 // 5 days ago
      const deleteBranch = vi.fn()

      const git = createGitProvider({
        listBranches: vi.fn().mockResolvedValue([
          { name: `cr/content/posts/en/${recentTimestamp}-a1b2`, sha: 'sha1', protected: false },
        ]),
        isMerged: vi.fn().mockResolvedValue(true),
        deleteBranch,
      })

      const report = await cleanupMergedBranches(git, 'project-1')

      expect(deleteBranch).not.toHaveBeenCalled()
      expect(report.deleted).toHaveLength(0)
      expect(report.remaining).toBe(1)
    })

    it('never deletes unmerged branches', async () => {
      const oldTimestamp = Math.floor(Date.now() / 1000) - 90 * 24 * 60 * 60 // 90 days ago
      const deleteBranch = vi.fn()

      const git = createGitProvider({
        listBranches: vi.fn().mockResolvedValue([
          { name: `cr/content/posts/en/${oldTimestamp}-a1b2`, sha: 'sha1', protected: false },
        ]),
        isMerged: vi.fn().mockResolvedValue(false),
        deleteBranch,
      })

      const report = await cleanupMergedBranches(git, 'project-1')

      expect(deleteBranch).not.toHaveBeenCalled()
      expect(report.deleted).toHaveLength(0)
      expect(report.remaining).toBe(1)
    })

    it('continues cleanup if one branch delete fails', async () => {
      const old1 = Math.floor(Date.now() / 1000) - 40 * 24 * 60 * 60
      const old2 = Math.floor(Date.now() / 1000) - 45 * 24 * 60 * 60
      const deleteBranch = vi.fn()
        .mockRejectedValueOnce(new Error('already deleted'))
        .mockResolvedValueOnce(undefined)

      const git = createGitProvider({
        listBranches: vi.fn().mockResolvedValue([
          { name: `cr/content/a/${old1}-aa`, sha: 'sha1', protected: false },
          { name: `cr/content/b/${old2}-bb`, sha: 'sha2', protected: false },
        ]),
        isMerged: vi.fn().mockResolvedValue(true),
        deleteBranch,
      })

      const report = await cleanupMergedBranches(git, 'project-1')

      // One failed, one succeeded
      expect(deleteBranch).toHaveBeenCalledTimes(2)
      expect(report.deleted).toHaveLength(1)
      expect(report.remaining).toBe(1)
    })

    it('respects custom retention days', async () => {
      const timestamp8DaysAgo = Math.floor(Date.now() / 1000) - 8 * 24 * 60 * 60
      const deleteBranch = vi.fn().mockResolvedValue(undefined)

      const git = createGitProvider({
        listBranches: vi.fn().mockResolvedValue([
          { name: `cr/content/posts/en/${timestamp8DaysAgo}-a1b2`, sha: 'sha1', protected: false },
        ]),
        isMerged: vi.fn().mockResolvedValue(true),
        deleteBranch,
      })

      // With default 30 days retention: should NOT delete (8 < 30)
      const report30 = await cleanupMergedBranches(git, 'project-1', 30)
      expect(report30.deleted).toHaveLength(0)

      // With 7 days retention: SHOULD delete (8 > 7)
      const report7 = await cleanupMergedBranches(git, 'project-1', 7)
      expect(report7.deleted).toHaveLength(1)
    })

    it('deletes branches with unparseable timestamps (no retention protection)', async () => {
      const deleteBranch = vi.fn().mockResolvedValue(undefined)

      const git = createGitProvider({
        listBranches: vi.fn().mockResolvedValue([
          { name: 'cr/content/posts/en/no-timestamp-here', sha: 'sha1', protected: false },
        ]),
        isMerged: vi.fn().mockResolvedValue(true),
        deleteBranch,
      })

      const report = await cleanupMergedBranches(git, 'project-1')

      expect(deleteBranch).toHaveBeenCalled()
      expect(report.deleted).toHaveLength(1)
    })

    it('updates health cache after cleanup', async () => {
      const oldTimestamp = Math.floor(Date.now() / 1000) - 40 * 24 * 60 * 60

      const git = createGitProvider({
        listBranches: vi.fn().mockResolvedValue([
          { name: `cr/content/a/${oldTimestamp}-aa`, sha: 'sha1', protected: false },
          { name: 'cr/content/b/recent-bb', sha: 'sha2', protected: false },
        ]),
        isMerged: vi.fn()
          .mockResolvedValueOnce(true) // a is merged
          .mockResolvedValueOnce(false), // b is unmerged
        deleteBranch: vi.fn().mockResolvedValue(undefined),
      })

      await cleanupMergedBranches(git, 'project-1')

      const cached = getHealthStatus('project-1')
      expect(cached).toBeDefined()
      expect(cached!.remaining).toBeUndefined() // cache stores unmergedCount, not remaining
      expect(cached!.status).toBe('ok')
    })

    it('handles empty branch list gracefully', async () => {
      const git = createGitProvider({
        listBranches: vi.fn().mockResolvedValue([]),
        isMerged: vi.fn(),
        deleteBranch: vi.fn(),
      })

      const report = await cleanupMergedBranches(git, 'project-1')

      expect(report.deleted).toHaveLength(0)
      expect(report.remaining).toBe(0)
      expect(report.status).toBe('ok')
    })
  })

  // ── Health guard integration (via createFeatureBranch) ──

  describe('createFeatureBranch health guard', () => {
    it('blocks branch creation when 80+ unmerged branches exist', async () => {
      const { createFeatureBranch } = await import('../../server/utils/content-engine/helpers')

      // Pre-populate cache with blocked status
      setHealthStatus('blocked-project', {
        status: 'blocked',
        unmergedCount: 85,
        lastChecked: new Date().toISOString(),
      })

      const git = createGitProvider()
      const ctx = {
        git,
        pathCtx: { contentRoot: '' },
        projectId: 'blocked-project',
        ensureContentBranch: vi.fn(),
        getProjectInfo: vi.fn(),
      }

      await expect(createFeatureBranch(ctx, 'content', 'posts', 'en'))
        .rejects.toMatchObject({ statusCode: 429 })
    })

    it('returns warning when 50+ unmerged branches exist', async () => {
      const { createFeatureBranch } = await import('../../server/utils/content-engine/helpers')

      setHealthStatus('warn-project', {
        status: 'warning',
        unmergedCount: 55,
        lastChecked: new Date().toISOString(),
      })

      const git = createGitProvider({
        createBranch: vi.fn().mockResolvedValue(undefined),
      })
      const ctx = {
        git,
        pathCtx: { contentRoot: '' },
        projectId: 'warn-project',
        ensureContentBranch: vi.fn(),
        getProjectInfo: vi.fn(),
      }

      const result = await createFeatureBranch(ctx, 'content', 'posts', 'en')

      expect(result.branchName).toMatch(/^cr\/content\/posts\/en\//)
      expect(result.healthWarning).toContain('55 unmerged branches')
    })

    it('skips health check when projectId is not set', async () => {
      const { createFeatureBranch } = await import('../../server/utils/content-engine/helpers')

      const git = createGitProvider({
        createBranch: vi.fn().mockResolvedValue(undefined),
      })
      const ctx = {
        git,
        pathCtx: { contentRoot: '' },
        ensureContentBranch: vi.fn(),
        getProjectInfo: vi.fn(),
      }

      const result = await createFeatureBranch(ctx, 'content', 'posts', 'en')

      expect(result.branchName).toMatch(/^cr\/content\/posts\/en\//)
      expect(result.healthWarning).toBeUndefined()
    })

    it('fetches fresh health when cache is empty', async () => {
      const { createFeatureBranch } = await import('../../server/utils/content-engine/helpers')

      const git = createGitProvider({
        listBranches: vi.fn().mockResolvedValue([]),
        isMerged: vi.fn(),
        createBranch: vi.fn().mockResolvedValue(undefined),
      })
      const ctx = {
        git,
        pathCtx: { contentRoot: '' },
        projectId: 'fresh-project',
        ensureContentBranch: vi.fn(),
        getProjectInfo: vi.fn(),
      }

      const result = await createFeatureBranch(ctx, 'content', 'posts')

      // Should have called listBranches for health check
      expect(git.listBranches).toHaveBeenCalledWith('cr/')
      expect(result.branchName).toMatch(/^cr\/content\/posts\//)
    })
  })
})

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mockNuxtImport } from '@nuxt/test-utils/runtime'
import { useBranches } from '../../../app/composables/useBranches'

const success = vi.fn()
const error = vi.fn()
const warning = vi.fn()

mockNuxtImport('useToast', () => () => ({
  success,
  error,
  warning,
}))

describe('useBranches', () => {
  beforeEach(() => {
    success.mockReset()
    error.mockReset()
    warning.mockReset()
    useState('branches').value = []
    useState('branches-loading').value = false
    useState('branch-review').value = null
    useState('branch-raw').value = null
    useState('branch-review-loading').value = false
    useState('branch-raw-loading').value = false
  })

  it('encodes branch names when requesting the review', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      branch: 'cr/content/faq/en/1234567890-abcd',
      groups: [],
      schema: [],
      settings: [],
      unclassified: [],
      summary: { added: 0, updated: 0, removed: 0 },
    })
    vi.stubGlobal('$fetch', fetchMock)

    const store = useBranches()
    await store.fetchBranchReview('workspace-1', 'project-1', 'cr/content/faq/en/1234567890-abcd')

    expect(fetchMock).toHaveBeenCalledWith(
      `/api/workspaces/workspace-1/projects/project-1/branches/${encodeURIComponent('cr/content/faq/en/1234567890-abcd')}/diff`,
    )
    expect(store.branchReview.value?.branch).toBe('cr/content/faq/en/1234567890-abcd')
  })

  it('removes merged branches from local state and shows a success toast', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ merged: true })
    vi.stubGlobal('$fetch', fetchMock)
    useState('branches').value = [
      { name: 'cr/content/faq/en/1234567890-abcd', sha: 'sha-1', protected: false },
      { name: 'cr/content/blog/en/1234567890-efgh', sha: 'sha-2', protected: false },
    ]

    const store = useBranches()
    const merged = await store.mergeBranch('workspace-1', 'project-1', 'cr/content/faq/en/1234567890-abcd')

    expect(merged).toBe(true)
    expect(success).toHaveBeenCalledWith('Change merged')
    expect(store.branches.value.map(branch => branch.name)).toEqual(['cr/content/blog/en/1234567890-efgh'])
  })

  it('asks for the file-level diff only when the technical view wants it', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ branch: 'cr/content/faq/en/1234567890-abcd', groups: [], schema: [], settings: [], unclassified: [], summary: { added: 0, updated: 0, removed: 0 } })
      .mockResolvedValueOnce({ branch: 'cr/content/faq/en/1234567890-abcd', files: [], contents: {} })
    vi.stubGlobal('$fetch', fetchMock)

    const store = useBranches()
    await store.fetchBranchReview('workspace-1', 'project-1', 'cr/content/faq/en/1234567890-abcd')
    // Selecting a branch costs one request, and it is not the whole-file one.
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0]?.[1]).toBeUndefined()

    await store.fetchBranchRaw('workspace-1', 'project-1', 'cr/content/faq/en/1234567890-abcd')
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls[1]?.[1]).toEqual({ query: { raw: 1 } })

    // Re-opening the same branch's technical view does not re-read the files.
    await store.fetchBranchRaw('workspace-1', 'project-1', 'cr/content/faq/en/1234567890-abcd')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('tells the truth when the merge landed but main is blocked', async () => {
    // The collabers incident, as the editor sees it: the content reached the
    // content branch, main could not follow. That is a merged change with a
    // pending publish — not a failure, and not silence.
    vi.stubGlobal('$fetch', vi.fn().mockResolvedValue({
      merged: true,
      mainAdvance: 'blocked_diverged',
      pullRequestUrl: 'https://example.com/pr/7',
    }))
    useState('branches').value = [
      { name: 'cr/content/faq/en/1234567890-abcd', sha: 'sha-1', protected: false },
    ]

    const store = useBranches()
    const merged = await store.mergeBranch('workspace-1', 'project-1', 'cr/content/faq/en/1234567890-abcd')

    // Merged from the editor's point of view: the branch leaves the list.
    expect(merged).toBe(true)
    expect(store.branches.value).toEqual([])
    // But the publish state is said out loud, as a warning — not a success.
    expect(warning).toHaveBeenCalledTimes(1)
    expect(success).not.toHaveBeenCalled()
  })

  it('reports a real conflict as an error, not a success', async () => {
    vi.stubGlobal('$fetch', vi.fn().mockResolvedValue({ merged: false }))
    useState('branches').value = [
      { name: 'cr/content/faq/en/1234567890-abcd', sha: 'sha-1', protected: false },
    ]

    const store = useBranches()
    const merged = await store.mergeBranch('workspace-1', 'project-1', 'cr/content/faq/en/1234567890-abcd')

    expect(merged).toBe(false)
    expect(error).toHaveBeenCalledTimes(1)
    // An unmerged branch stays in the list — it still needs resolving.
    expect(store.branches.value).toHaveLength(1)
  })

  it('returns false and shows an error toast when merge fails', async () => {
    vi.stubGlobal('$fetch', vi.fn().mockRejectedValue(new Error('Merge failed on server')))

    const store = useBranches()
    const merged = await store.mergeBranch('workspace-1', 'project-1', 'cr/content/faq/en/1234567890-abcd')

    expect(merged).toBe(false)
    // Error without statusCode → resolveApiError returns user-friendly fallback (not raw error)
    expect(error).not.toHaveBeenCalledWith('Merge failed on server')
    expect(error).toHaveBeenCalledTimes(1)
  })
})

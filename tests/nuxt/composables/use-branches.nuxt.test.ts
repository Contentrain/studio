import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mockNuxtImport } from '@nuxt/test-utils/runtime'
import { useBranches } from '../../../app/composables/useBranches'

const success = vi.fn()
const error = vi.fn()

mockNuxtImport('useToast', () => () => ({
  success,
  error,
}))

describe('useBranches', () => {
  beforeEach(() => {
    success.mockReset()
    error.mockReset()
    useState('branches').value = []
    useState('branches-loading').value = false
    useState('branch-diff').value = null
    useState('branch-diff-loading').value = false
  })

  it('encodes branch names when requesting diffs', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      branch: 'cr/content/faq/en/1234567890-abcd',
      files: [],
      contents: {},
    })
    vi.stubGlobal('$fetch', fetchMock)

    const store = useBranches()
    await store.fetchBranchDiff('workspace-1', 'project-1', 'cr/content/faq/en/1234567890-abcd')

    expect(fetchMock).toHaveBeenCalledWith(
      `/api/workspaces/workspace-1/projects/project-1/branches/${encodeURIComponent('cr/content/faq/en/1234567890-abcd')}/diff`,
    )
    expect(store.branchDiff.value?.branch).toBe('cr/content/faq/en/1234567890-abcd')
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
    expect(success).toHaveBeenCalledWith('Branch merged: cr/content/faq/en/1234567890-abcd')
    expect(store.branches.value.map(branch => branch.name)).toEqual(['cr/content/blog/en/1234567890-efgh'])
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

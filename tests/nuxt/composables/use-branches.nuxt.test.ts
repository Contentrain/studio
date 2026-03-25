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
      branch: 'contentrain/save-123',
      files: [],
      contents: {},
    })
    vi.stubGlobal('$fetch', fetchMock)

    const store = useBranches()
    await store.fetchBranchDiff('workspace-1', 'project-1', 'contentrain/save-123')

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/workspaces/workspace-1/projects/project-1/branches/contentrain%2Fsave-123/diff',
    )
    expect(store.branchDiff.value?.branch).toBe('contentrain/save-123')
  })

  it('removes merged branches from local state and shows a success toast', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ merged: true })
    vi.stubGlobal('$fetch', fetchMock)
    useState('branches').value = [
      { name: 'contentrain/save-123', sha: 'sha-1', protected: false },
      { name: 'contentrain/save-456', sha: 'sha-2', protected: false },
    ]

    const store = useBranches()
    const merged = await store.mergeBranch('workspace-1', 'project-1', 'contentrain/save-123')

    expect(merged).toBe(true)
    expect(success).toHaveBeenCalledWith('Branch merged: contentrain/save-123')
    expect(store.branches.value.map(branch => branch.name)).toEqual(['contentrain/save-456'])
  })

  it('returns false and shows an error toast when merge fails', async () => {
    vi.stubGlobal('$fetch', vi.fn().mockRejectedValue(new Error('Merge failed on server')))

    const store = useBranches()
    const merged = await store.mergeBranch('workspace-1', 'project-1', 'contentrain/save-123')

    expect(merged).toBe(false)
    expect(error).toHaveBeenCalledWith('Merge failed on server')
  })
})

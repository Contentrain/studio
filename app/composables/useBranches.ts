/**
 * Branch management composable.
 * Lists contentrain/* branches, merge/reject, and branch diff.
 */

interface BranchSummary {
  name: string
  sha: string
  protected: boolean
}

interface FileDiff {
  path: string
  status: 'added' | 'modified' | 'removed'
}

interface BranchDiffData {
  branch: string
  files: FileDiff[]
  contents: Record<string, { before: unknown, after: unknown }>
}

export function useBranches() {
  const branches = useState<BranchSummary[]>('branches', () => [])
  const loading = useState('branches-loading', () => false)
  const branchDiff = useState<BranchDiffData | null>('branch-diff', () => null)
  const diffLoading = useState('branch-diff-loading', () => false)
  const toast = useToast()

  async function fetchBranches(workspaceId: string, projectId: string) {
    loading.value = true
    try {
      const result = await $fetch<{ branches: BranchSummary[] }>(
        `/api/workspaces/${workspaceId}/projects/${projectId}/branches`,
      )
      branches.value = result.branches
    }
    catch {
      branches.value = []
    }
    finally {
      loading.value = false
    }
  }

  async function fetchBranchDiff(workspaceId: string, projectId: string, branch: string) {
    diffLoading.value = true
    try {
      branchDiff.value = await $fetch<BranchDiffData>(
        `/api/workspaces/${workspaceId}/projects/${projectId}/branches/${encodeURIComponent(branch)}/diff`,
      )
    }
    catch {
      branchDiff.value = null
    }
    finally {
      diffLoading.value = false
    }
  }

  function clearBranchDiff() {
    branchDiff.value = null
  }

  async function mergeBranch(workspaceId: string, projectId: string, branch: string): Promise<boolean> {
    try {
      const result = await $fetch<{ merged: boolean }>(
        `/api/workspaces/${workspaceId}/projects/${projectId}/branches/${encodeURIComponent(branch)}/merge`,
        { method: 'POST' },
      )
      if (result.merged) {
        toast.success(`Branch merged: ${branch}`)
        branches.value = branches.value.filter(b => b.name !== branch)
        return true
      }
      toast.error('Merge conflict — resolve manually on GitHub')
      return false
    }
    catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Merge failed')
      return false
    }
  }

  async function rejectBranch(workspaceId: string, projectId: string, branch: string): Promise<boolean> {
    try {
      await $fetch(
        `/api/workspaces/${workspaceId}/projects/${projectId}/branches/${encodeURIComponent(branch)}/reject`,
        { method: 'POST' },
      )
      toast.success(`Branch rejected: ${branch}`)
      branches.value = branches.value.filter(b => b.name !== branch)
      return true
    }
    catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Reject failed')
      return false
    }
  }

  return {
    branches: readonly(branches),
    loading: readonly(loading),
    branchDiff: readonly(branchDiff),
    diffLoading: readonly(diffLoading),
    fetchBranches,
    fetchBranchDiff,
    clearBranchDiff,
    mergeBranch,
    rejectBranch,
  }
}

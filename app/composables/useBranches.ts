/**
 * Branch management composable.
 * Lists cr/* branches, merge/reject, and the branch review.
 */
import type { BranchListItem, BranchReview } from '~~/shared/utils/branch-review'

/** The file-level diff behind the panel's technical view. Fetched on demand. */
export interface BranchRawDiff {
  branch: string
  files: Array<{ path: string, status: 'added' | 'modified' | 'removed' }>
  contents: Record<string, { before: unknown, after: unknown }>
}

export function useBranches() {
  const branches = useState<BranchListItem[]>('branches', () => [])
  const loading = useState('branches-loading', () => false)
  const branchReview = useState<BranchReview | null>('branch-review', () => null)
  const branchRaw = useState<BranchRawDiff | null>('branch-raw', () => null)
  const reviewLoading = useState('branch-review-loading', () => false)
  const rawLoading = useState('branch-raw-loading', () => false)
  const toast = useToast()

  function branchUrl(workspaceId: string, projectId: string, branch: string) {
    return `/api/workspaces/${workspaceId}/projects/${projectId}/branches/${encodeURIComponent(branch)}`
  }

  async function fetchBranches(workspaceId: string, projectId: string) {
    loading.value = true
    try {
      const result = await $fetch<{ branches: BranchListItem[] }>(
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

  async function fetchBranchReview(workspaceId: string, projectId: string, branch: string) {
    reviewLoading.value = true
    // The raw view belongs to whichever branch is open; keep it from bleeding
    // across a selection change.
    branchRaw.value = null
    try {
      branchReview.value = await $fetch<BranchReview>(`${branchUrl(workspaceId, projectId, branch)}/diff`)
    }
    catch {
      branchReview.value = null
    }
    finally {
      reviewLoading.value = false
    }
  }

  /**
   * The file-level diff, only when someone opens the technical view. It reads
   * every changed file whole, which is exactly the cost the review payload
   * exists to avoid paying by default.
   */
  async function fetchBranchRaw(workspaceId: string, projectId: string, branch: string) {
    if (branchRaw.value?.branch === branch) return
    rawLoading.value = true
    try {
      branchRaw.value = await $fetch<BranchRawDiff>(
        `${branchUrl(workspaceId, projectId, branch)}/diff`,
        { query: { raw: 1 } },
      )
    }
    catch {
      branchRaw.value = null
    }
    finally {
      rawLoading.value = false
    }
  }

  function clearBranchReview() {
    branchReview.value = null
    branchRaw.value = null
  }

  function clearBranches() {
    branches.value = []
    clearBranchReview()
  }

  async function mergeBranch(workspaceId: string, projectId: string, branch: string): Promise<boolean> {
    const { t } = useContent()
    try {
      const result = await $fetch<{
        merged: boolean
        mainAdvance?: 'advanced' | 'blocked_diverged'
        pullRequestUrl?: string | null
      }>(`${branchUrl(workspaceId, projectId, branch)}/merge`, { method: 'POST' })
      if (result.merged) {
        // `merged` means the content landed on the branch every reader uses.
        // Whether main advanced with it is a separate fact — telling the
        // editor "merge failed" for a blocked advance is how an Approve on a
        // diverged repo used to read as a lost save.
        if (result.mainAdvance === 'blocked_diverged') {
          toast.warning(t('branch.merge_publish_pending'))
        }
        else {
          toast.success(t('branch.merge_success'))
        }
        branches.value = branches.value.filter(b => b.name !== branch)
        return true
      }
      toast.error(t('branch.merge_conflict'))
      return false
    }
    catch (e: unknown) {
      toast.error(resolveApiError(e, t('branch.merge_error')))
      return false
    }
  }

  async function rejectBranch(workspaceId: string, projectId: string, branch: string): Promise<boolean> {
    const { t } = useContent()
    try {
      await $fetch(`${branchUrl(workspaceId, projectId, branch)}/reject`, { method: 'POST' })
      toast.success(t('branch.reject_success'))
      branches.value = branches.value.filter(b => b.name !== branch)
      return true
    }
    catch (e: unknown) {
      toast.error(resolveApiError(e, t('branch.reject_error')))
      return false
    }
  }

  async function requestChanges(workspaceId: string, projectId: string, branch: string, comment: string): Promise<boolean> {
    const { t } = useContent()
    try {
      const result = await $fetch<{ changesRequested: { comment: string, requestedBy: string | null, requestedAt: string } }>(
        `${branchUrl(workspaceId, projectId, branch)}/request-changes`,
        { method: 'POST', body: { comment } },
      )
      if (branchReview.value?.branch === branch)
        branchReview.value = { ...branchReview.value, changesRequested: result.changesRequested }
      branches.value = branches.value.map(b => b.name === branch ? { ...b, changesRequested: true } : b)
      toast.success(t('review.request_sent'))
      return true
    }
    catch (e: unknown) {
      toast.error(resolveApiError(e, t('review.request_failed')))
      return false
    }
  }

  async function resolveChangeRequest(workspaceId: string, projectId: string, branch: string): Promise<boolean> {
    const { t } = useContent()
    try {
      await $fetch(`${branchUrl(workspaceId, projectId, branch)}/request-changes`, { method: 'DELETE' })
      if (branchReview.value?.branch === branch)
        branchReview.value = { ...branchReview.value, changesRequested: null }
      branches.value = branches.value.map(b => b.name === branch ? { ...b, changesRequested: false } : b)
      toast.success(t('review.request_resolved'))
      return true
    }
    catch (e: unknown) {
      toast.error(resolveApiError(e, t('review.request_failed')))
      return false
    }
  }

  return {
    branches: readonly(branches),
    loading: readonly(loading),
    branchReview: readonly(branchReview),
    branchRaw: readonly(branchRaw),
    reviewLoading: readonly(reviewLoading),
    rawLoading: readonly(rawLoading),
    fetchBranches,
    fetchBranchReview,
    fetchBranchRaw,
    clearBranchReview,
    clearBranches,
    mergeBranch,
    rejectBranch,
    requestChanges,
    resolveChangeRequest,
  }
}

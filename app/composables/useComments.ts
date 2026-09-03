export type CommentStatus = 'pending' | 'approved' | 'rejected' | 'spam'

export interface StudioComment {
  id: string
  project_id: string
  workspace_id: string
  model_id: string
  entry_id: string
  locale: string
  parent_id: string | null
  root_id: string
  depth: number
  author_name: string
  author_email: string | null
  author_url: string | null
  author_user_id: string | null
  body: string
  status: CommentStatus
  type: 'comment' | 'pingback' | 'trackback'
  source: 'web' | 'import' | 'studio'
  source_id: string | null
  source_ip: string | null
  user_agent: string | null
  referrer: string | null
  moderated_at: string | null
  moderated_by: string | null
  created_at: string
  updated_at: string
}

export interface CommentCounts {
  pending: number
  approved: number
  spam: number
  rejected: number
}

export interface CommentListOptions {
  status?: CommentStatus
  modelId?: string
  entryId?: string
  locale?: string
  page?: number
  limit?: number
  sort?: 'newest' | 'oldest'
}

/**
 * Moderation client for `/api/workspaces/{ws}/projects/{p}/comments`.
 * State is per-project (keyed by useState) so the moderation view and the
 * detail modal share one list; every mutation patches the local rows so the
 * UI reflects it without a refetch.
 */
export function useComments(workspaceId: MaybeRefOrGetter<string>, projectId: MaybeRefOrGetter<string>) {
  const comments = useState<StudioComment[]>('comments-list', () => [])
  const total = useState<number>('comments-total', () => 0)
  const counts = useState<CommentCounts>('comments-counts', () => ({ pending: 0, approved: 0, spam: 0, rejected: 0 }))
  const loading = useState<boolean>('comments-loading', () => false)

  const base = () => `/api/workspaces/${toValue(workspaceId)}/projects/${toValue(projectId)}/comments`

  async function fetchComments(options: CommentListOptions = {}) {
    loading.value = true
    try {
      const result = await $fetch<{ comments: StudioComment[], total: number, counts: CommentCounts }>(base(), { params: options })
      comments.value = result.comments
      total.value = result.total
      counts.value = result.counts
    }
    catch {
      comments.value = []
      total.value = 0
    }
    finally {
      loading.value = false
    }
  }

  function patchLocal(id: string, patch: Partial<StudioComment>) {
    const idx = comments.value.findIndex(c => c.id === id)
    if (idx !== -1) comments.value[idx] = { ...comments.value[idx]!, ...patch }
  }

  function shiftCounts(from: CommentStatus | null, to: CommentStatus | null) {
    if (from) counts.value[from] = Math.max(0, counts.value[from] - 1)
    if (to) counts.value[to] += 1
  }

  async function setStatus(id: string, status: CommentStatus) {
    const previous = comments.value.find(c => c.id === id)?.status ?? null
    const updated = await $fetch<StudioComment>(`${base()}/${id}`, { method: 'PATCH', body: { status } })
    patchLocal(id, updated)
    if (previous !== status) shiftCounts(previous, status)
    return updated
  }

  async function deleteComment(id: string) {
    const previous = comments.value.find(c => c.id === id)?.status ?? null
    await $fetch(`${base()}/${id}`, { method: 'DELETE' })
    comments.value = comments.value.filter(c => c.id !== id)
    total.value = Math.max(0, total.value - 1)
    shiftCounts(previous, null)
  }

  async function reply(id: string, body: string) {
    const created = await $fetch<StudioComment>(`${base()}/${id}/reply`, { method: 'POST', body: { body } })
    const parent = comments.value.find(c => c.id === id)
    if (parent && parent.status !== 'approved') {
      shiftCounts(parent.status, 'approved')
      patchLocal(id, { status: 'approved' })
    }
    return created
  }

  async function bulk(action: 'approve' | 'reject' | 'spam' | 'pending' | 'delete', ids: string[]) {
    await $fetch(`${base()}/bulk`, { method: 'POST', body: { action, commentIds: ids } })
    const idSet = new Set(ids)
    if (action === 'delete') {
      for (const c of comments.value) if (idSet.has(c.id)) shiftCounts(c.status, null)
      comments.value = comments.value.filter(c => !idSet.has(c.id))
      total.value = Math.max(0, total.value - ids.length)
      return
    }
    const statusMap: Record<Exclude<typeof action, 'delete'>, CommentStatus> = { approve: 'approved', reject: 'rejected', spam: 'spam', pending: 'pending' }
    const next = statusMap[action]
    for (const c of comments.value) {
      if (idSet.has(c.id) && c.status !== next) {
        shiftCounts(c.status, next)
        c.status = next
      }
    }
  }

  async function setThreadClosed(modelId: string, entryId: string, closed: boolean, locale = 'en') {
    return $fetch<{ closed: boolean }>(`${base()}/threads/${modelId}/${entryId}`, { method: 'PATCH', body: { closed, locale } })
  }

  return {
    comments: readonly(comments),
    total: readonly(total),
    counts: readonly(counts),
    loading: readonly(loading),
    fetchComments,
    setStatus,
    deleteComment,
    reply,
    bulk,
    setThreadClosed,
  }
}

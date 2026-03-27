export interface FormSubmission {
  id: string
  project_id: string
  workspace_id: string
  model_id: string
  data: Record<string, unknown>
  status: 'pending' | 'approved' | 'rejected' | 'spam'
  source_ip: string | null
  user_agent: string | null
  referrer: string | null
  locale: string
  approved_at: string | null
  approved_by: string | null
  entry_id: string | null
  created_at: string
}

export function useFormSubmissions() {
  const submissions = useState<FormSubmission[]>('form-submissions', () => [])
  const total = useState<number>('form-submissions-total', () => 0)
  const loading = useState<boolean>('form-submissions-loading', () => false)
  const activeModelId = useState<string | null>('form-submissions-model', () => null)

  async function fetchSubmissions(
    workspaceId: string,
    projectId: string,
    modelId: string,
    options?: { page?: number, limit?: number, status?: string, sort?: 'newest' | 'oldest' },
  ) {
    loading.value = true
    activeModelId.value = modelId
    try {
      const result = await $fetch<{ submissions: FormSubmission[], total: number }>(
        `/api/workspaces/${workspaceId}/projects/${projectId}/forms/${modelId}/submissions`,
        { params: options },
      )
      submissions.value = result.submissions
      total.value = result.total
    }
    catch {
      submissions.value = []
      total.value = 0
    }
    finally {
      loading.value = false
    }
  }

  async function approveSubmission(workspaceId: string, projectId: string, modelId: string, submissionId: string) {
    await $fetch(
      `/api/workspaces/${workspaceId}/projects/${projectId}/forms/${modelId}/submissions/${submissionId}`,
      { method: 'PATCH', body: { status: 'approved' } },
    )
    // Update local state
    const idx = submissions.value.findIndex(s => s.id === submissionId)
    if (idx !== -1) submissions.value[idx] = { ...submissions.value[idx]!, status: 'approved', approved_at: new Date().toISOString() }
  }

  async function rejectSubmission(workspaceId: string, projectId: string, modelId: string, submissionId: string) {
    await $fetch(
      `/api/workspaces/${workspaceId}/projects/${projectId}/forms/${modelId}/submissions/${submissionId}`,
      { method: 'PATCH', body: { status: 'rejected' } },
    )
    const idx = submissions.value.findIndex(s => s.id === submissionId)
    if (idx !== -1) submissions.value[idx] = { ...submissions.value[idx]!, status: 'rejected' }
  }

  async function deleteSubmission(workspaceId: string, projectId: string, modelId: string, submissionId: string) {
    await $fetch(
      `/api/workspaces/${workspaceId}/projects/${projectId}/forms/${modelId}/submissions/${submissionId}`,
      { method: 'DELETE' },
    )
    submissions.value = submissions.value.filter(s => s.id !== submissionId)
    total.value = Math.max(0, total.value - 1)
  }

  async function bulkAction(
    workspaceId: string,
    projectId: string,
    modelId: string,
    action: 'approve' | 'reject' | 'spam' | 'delete',
    submissionIds: string[],
  ) {
    await $fetch(
      `/api/workspaces/${workspaceId}/projects/${projectId}/forms/${modelId}/submissions/bulk`,
      { method: 'POST', body: { action, submissionIds } },
    )
    if (action === 'delete') {
      const idSet = new Set(submissionIds)
      submissions.value = submissions.value.filter(s => !idSet.has(s.id))
      total.value = Math.max(0, total.value - submissionIds.length)
    }
    else {
      for (const s of submissions.value) {
        if (submissionIds.includes(s.id)) {
          const statusMap: Record<string, FormSubmission['status']> = { approve: 'approved', reject: 'rejected', spam: 'spam' }
          s.status = statusMap[action] ?? s.status
        }
      }
    }
  }

  const pendingCount = computed(() => submissions.value.filter(s => s.status === 'pending').length)

  function clearSubmissions() {
    submissions.value = []
    total.value = 0
    activeModelId.value = null
  }

  return {
    submissions: readonly(submissions),
    total: readonly(total),
    loading: readonly(loading),
    activeModelId: readonly(activeModelId),
    pendingCount,
    fetchSubmissions,
    approveSubmission,
    rejectSubmission,
    deleteSubmission,
    bulkAction,
    clearSubmissions,
  }
}

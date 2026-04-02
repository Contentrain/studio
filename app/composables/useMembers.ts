/**
 * Workspace + project member management composable.
 */

interface Profile {
  id: string
  display_name: string | null
  email: string
  avatar_url: string | null
}

export interface WorkspaceMember {
  id: string
  role: 'owner' | 'admin' | 'member'
  invited_email: string | null
  invited_at: string
  accepted_at: string | null
  profiles: Profile | null
}

export interface ProjectMember {
  id: string
  role: 'editor' | 'reviewer' | 'viewer'
  specific_models: boolean
  allowed_models: string[]
  invited_email: string | null
  invited_at: string
  accepted_at: string | null
  profiles: Profile | null
}

export function useMembers() {
  const members = useState<WorkspaceMember[]>('workspace-members', () => [])
  const projectMembers = useState<ProjectMember[]>('project-members', () => [])
  const loading = useState('members-loading', () => false)
  const toast = useToast()
  const { t } = useContent()

  async function fetchMembers(workspaceId: string) {
    loading.value = true
    try {
      members.value = await $fetch<WorkspaceMember[]>(
        `/api/workspaces/${workspaceId}/members`,
      )
    }
    catch {
      members.value = []
    }
    finally {
      loading.value = false
    }
  }

  async function inviteMember(workspaceId: string, email: string, role: 'admin' | 'member'): Promise<boolean> {
    try {
      await $fetch(`/api/workspaces/${workspaceId}/members`, {
        method: 'POST',
        body: { email, role },
      })
      toast.success(t('members.invite_success'))
      await fetchMembers(workspaceId)
      return true
    }
    catch (e: unknown) {
      toast.error(resolveApiError(e, t('members.invite_error')))
      return false
    }
  }

  async function updateMemberRole(workspaceId: string, memberId: string, role: 'admin' | 'member'): Promise<boolean> {
    try {
      await $fetch(`/api/workspaces/${workspaceId}/members/${memberId}`, {
        method: 'PATCH',
        body: { role },
      })
      toast.success(t('members.role_update_success'))
      await fetchMembers(workspaceId)
      return true
    }
    catch (e: unknown) {
      toast.error(resolveApiError(e, t('members.role_update_error')))
      return false
    }
  }

  async function removeMember(workspaceId: string, memberId: string): Promise<boolean> {
    try {
      await $fetch(`/api/workspaces/${workspaceId}/members/${memberId}`, {
        method: 'DELETE',
      })
      toast.success(t('members.remove_success'))
      members.value = members.value.filter(m => m.id !== memberId)
      return true
    }
    catch (e: unknown) {
      toast.error(resolveApiError(e, t('members.remove_error')))
      return false
    }
  }

  // Project members
  async function fetchProjectMembers(workspaceId: string, projectId: string) {
    try {
      projectMembers.value = await $fetch<ProjectMember[]>(
        `/api/workspaces/${workspaceId}/projects/${projectId}/members`,
      )
    }
    catch {
      projectMembers.value = []
    }
  }

  async function assignProjectMember(
    workspaceId: string,
    projectId: string,
    email: string,
    role: 'editor' | 'reviewer' | 'viewer',
  ): Promise<boolean> {
    try {
      await $fetch(`/api/workspaces/${workspaceId}/projects/${projectId}/members`, {
        method: 'POST',
        body: { email, role },
      })
      toast.success(t('members.assign_success'))
      await fetchProjectMembers(workspaceId, projectId)
      return true
    }
    catch (e: unknown) {
      toast.error(resolveApiError(e, t('members.assign_error')))
      return false
    }
  }

  async function removeProjectMember(workspaceId: string, projectId: string, memberId: string): Promise<boolean> {
    try {
      await $fetch(`/api/workspaces/${workspaceId}/projects/${projectId}/members/${memberId}`, {
        method: 'DELETE',
      })
      toast.success(t('members.project_remove_success'))
      projectMembers.value = projectMembers.value.filter(m => m.id !== memberId)
      return true
    }
    catch (e: unknown) {
      toast.error(resolveApiError(e, t('members.project_remove_error')))
      return false
    }
  }

  async function resendInvite(workspaceId: string, memberId: string): Promise<boolean> {
    try {
      await $fetch(`/api/workspaces/${workspaceId}/members/${memberId}/resend`, {
        method: 'POST',
      })
      toast.success(t('members.resend_success'))
      // Refresh to update invited_at timestamp
      await fetchMembers(workspaceId)
      return true
    }
    catch (e: unknown) {
      toast.error(resolveApiError(e, t('members.resend_error')))
      return false
    }
  }

  return {
    members: readonly(members),
    projectMembers: readonly(projectMembers),
    loading: readonly(loading),
    fetchMembers,
    inviteMember,
    updateMemberRole,
    removeMember,
    resendInvite,
    fetchProjectMembers,
    assignProjectMember,
    removeProjectMember,
  }
}

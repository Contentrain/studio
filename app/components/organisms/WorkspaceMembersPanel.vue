<script setup lang="ts">
import type { WorkspaceMember } from '~/composables/useMembers'

defineProps<{
  workspaceId: string
}>()

const { activeWorkspace } = useWorkspaces()
const { projects, fetchProjects } = useProjects()
const { members, projectMembers, loading: membersLoading, fetchMembers, inviteMember, updateMemberRole, removeMember, resendInvite, fetchProjectMembers, assignProjectMember, removeProjectMember } = useMembers()
const { t } = useContent()

// Invite form state
const inviteEmail = ref('')
const inviteRole = ref<'admin' | 'member'>('member')
const inviting = ref(false)

// Project assign form state
const assignEmail = ref('')
const assignProjectId = ref('')
const assignRole = ref<'editor' | 'reviewer' | 'viewer'>('editor')
const assigning = ref(false)

// Member removal confirmation
const confirmRemoveId = ref<string | null>(null)

const wsRoleOptions = [
  { value: 'admin', label: t('members.role_admin') },
  { value: 'member', label: t('members.role_member') },
]

// Reviewer and Viewer project roles are backed by the enterprise
// bridge (`normalizeEnterpriseProjectMemberAccess` in ee/). In
// Community Edition, assigning either role silently degrades to
// Editor, so surface only the roles that actually work.
const reviewerRoleEnabled = useFeature('roles.reviewer')
const viewerRoleEnabled = useFeature('roles.viewer')

const projectRoleOptions = computed(() => {
  const options: Array<{ value: 'editor' | 'reviewer' | 'viewer', label: string }> = [
    { value: 'editor', label: t('members.role_editor') },
  ]
  if (reviewerRoleEnabled.value) options.push({ value: 'reviewer', label: t('members.role_reviewer') })
  if (viewerRoleEnabled.value) options.push({ value: 'viewer', label: t('members.role_viewer') })
  return options
})

const showRoleEEHint = computed(() => !reviewerRoleEnabled.value || !viewerRoleEnabled.value)

// Reset assignRole if the current value is no longer available.
watch(projectRoleOptions, (options) => {
  if (!options.some(o => o.value === assignRole.value)) assignRole.value = 'editor'
}, { immediate: true })

const projectOptions = computed(() =>
  projects.value.map(p => ({ value: p.id, label: p.repo_full_name.split('/').pop() ?? p.repo_full_name })),
)

const roleVariant: Record<string, 'primary' | 'success' | 'warning' | 'info' | 'secondary'> = {
  owner: 'primary',
  admin: 'info',
  member: 'secondary',
  editor: 'success',
  reviewer: 'warning',
  viewer: 'secondary',
}

// Load data when workspace is ready
watch(() => activeWorkspace.value?.id, async (wsId) => {
  if (!wsId) return
  await Promise.all([fetchMembers(wsId), fetchProjects(wsId)])
}, { immediate: true })

// Fetch project members when a project is selected
watch(assignProjectId, async (projectId) => {
  if (!projectId || !activeWorkspace.value) return
  await fetchProjectMembers(activeWorkspace.value.id, projectId)
})

async function handleInvite() {
  if (!activeWorkspace.value || !inviteEmail.value.trim()) return
  inviting.value = true
  const ok = await inviteMember(activeWorkspace.value.id, inviteEmail.value.trim(), inviteRole.value)
  if (ok) inviteEmail.value = ''
  inviting.value = false
}

async function handleRoleChange(member: WorkspaceMember, role: 'admin' | 'member') {
  if (!activeWorkspace.value) return
  await updateMemberRole(activeWorkspace.value.id, member.id, role)
}

async function handleRemove(memberId: string) {
  if (confirmRemoveId.value !== memberId) {
    confirmRemoveId.value = memberId
    return
  }
  if (!activeWorkspace.value) return
  confirmRemoveId.value = null
  await removeMember(activeWorkspace.value.id, memberId)
}

async function handleResend(memberId: string) {
  if (!activeWorkspace.value) return
  await resendInvite(activeWorkspace.value.id, memberId)
}

function getInviteDaysAgo(member: { invited_at?: string }): number {
  if (!member.invited_at) return 0
  return Math.floor((Date.now() - new Date(member.invited_at).getTime()) / (1000 * 60 * 60 * 24))
}

async function handleAssignProject() {
  if (!activeWorkspace.value || !assignEmail.value.trim() || !assignProjectId.value) return
  assigning.value = true
  const ok = await assignProjectMember(activeWorkspace.value.id, assignProjectId.value, assignEmail.value.trim(), assignRole.value)
  if (ok) assignEmail.value = ''
  assigning.value = false
}

async function handleRemoveProjectMember(memberId: string) {
  if (!activeWorkspace.value || !assignProjectId.value) return
  await removeProjectMember(activeWorkspace.value.id, assignProjectId.value, memberId)
}

function getMemberDisplayName(member: { profiles?: { display_name?: string | null, email?: string } | null, invited_email?: string | null }): string {
  return member.profiles?.display_name ?? member.profiles?.email ?? member.invited_email ?? '—'
}

function getMemberEmail(member: { profiles?: { email?: string } | null, invited_email?: string | null }): string {
  return member.profiles?.email ?? member.invited_email ?? ''
}
</script>

<template>
  <div class="space-y-8">
    <!-- Invite form -->
    <div class="max-w-md">
      <AtomsHeadingText :level="3" size="sm">
        {{ t('members.invite_title') }}
      </AtomsHeadingText>
      <form class="mt-3 flex items-end gap-2" @submit.prevent="handleInvite">
        <div class="flex-1">
          <AtomsFormInput
            v-model="inviteEmail"
            type="email"
            :placeholder="t('members.invite_placeholder')"
            required
          />
        </div>
        <AtomsFormSelect
          :model-value="inviteRole"
          :options="wsRoleOptions"
          size="md"
          @update:model-value="inviteRole = ($event as 'admin' | 'member')"
        />
        <AtomsBaseButton
          type="submit"
          variant="primary"
          size="md"
          :disabled="inviting || !inviteEmail.trim()"
        >
          {{ inviting ? t('members.inviting') : t('members.invite_button') }}
        </AtomsBaseButton>
      </form>
    </div>

    <!-- Workspace member list -->
    <div>
      <div class="mb-2 flex items-center gap-1">
        <AtomsSectionLabel :label="t('settings.members_title')" :count="members.length" />
        <AtomsInfoTooltip :text="t('settings.members_info')" />
      </div>

      <div v-if="membersLoading" class="space-y-2">
        <AtomsSkeleton v-for="i in 3" :key="i" variant="custom" class="h-14 w-full rounded-lg" />
      </div>

      <div v-else-if="members.length === 0" class="py-6">
        <AtomsEmptyState
          icon="icon-[annon--users]"
          :title="t('members.no_members')"
          :description="t('members.no_members_description')"
        />
      </div>

      <ul v-else class="divide-y divide-secondary-100 rounded-lg border border-secondary-200 dark:divide-secondary-800 dark:border-secondary-800">
        <li
          v-for="member in members"
          :key="member.id"
          class="flex items-center gap-3 px-4 py-3"
        >
          <AtomsAvatar
            :src="member.profiles?.avatar_url"
            :name="getMemberDisplayName(member)"
            size="sm"
          />
          <div class="min-w-0 flex-1">
            <div class="truncate text-sm font-medium text-heading dark:text-secondary-100">
              {{ getMemberDisplayName(member) }}
            </div>
            <div class="truncate text-xs text-muted">
              {{ getMemberEmail(member) }}
              <span v-if="!member.accepted_at" class="ml-1" :class="getInviteDaysAgo(member) > 30 ? 'text-danger-500' : 'text-warning-500'">
                ({{ getInviteDaysAgo(member) > 30 ? t('members.expired_invite') : t('members.pending') }})
              </span>
            </div>
          </div>

          <!-- Role -->
          <template v-if="member.role === 'owner'">
            <AtomsBadge :variant="roleVariant[member.role]" size="sm">
              {{ t('members.role_owner') }}
            </AtomsBadge>
          </template>
          <template v-else>
            <AtomsFormSelect
              :model-value="member.role"
              :options="wsRoleOptions"
              size="sm"
              @update:model-value="handleRoleChange(member, $event as 'admin' | 'member')"
            />
            <AtomsIconButton
              v-if="!member.accepted_at"
              icon="icon-[annon--email]"
              :label="t('members.resend')"
              size="sm"
              @click="handleResend(member.id)"
            />
            <AtomsIconButton
              icon="icon-[annon--trash]"
              :label="confirmRemoveId === member.id ? t('members.confirm_remove') : t('members.remove')"
              size="sm"
              @click="handleRemove(member.id)"
            />
          </template>
        </li>
      </ul>
    </div>

    <!-- Project Access -->
    <div v-if="projects.length > 0">
      <div class="flex items-center gap-1">
        <AtomsHeadingText :level="3" size="sm">
          {{ t('members.project_access') }}
        </AtomsHeadingText>
        <AtomsInfoTooltip :text="t('members.project_access_info')" />
      </div>
      <p class="mt-1 text-xs text-muted">
        {{ t('members.project_access_description') }}
      </p>

      <!-- Project selector + assign form -->
      <div class="mt-3 max-w-md space-y-3">
        <AtomsFormSelect
          :model-value="assignProjectId"
          :options="projectOptions"
          :placeholder="t('members.select_project')"
          size="md"
          @update:model-value="assignProjectId = $event"
        />

        <template v-if="assignProjectId">
          <form class="flex items-end gap-2" @submit.prevent="handleAssignProject">
            <div class="flex-1">
              <AtomsFormInput
                v-model="assignEmail"
                type="email"
                :placeholder="t('members.invite_placeholder')"
                required
              />
            </div>
            <AtomsFormSelect
              :model-value="assignRole"
              :options="projectRoleOptions"
              size="md"
              @update:model-value="assignRole = ($event as 'editor' | 'reviewer' | 'viewer')"
            />
            <AtomsInfoTooltip v-if="showRoleEEHint" :text="t('settings.role_ee_hint')" />
            <AtomsBaseButton
              type="submit"
              variant="primary"
              size="md"
              :disabled="assigning || !assignEmail.trim()"
            >
              {{ assigning ? t('members.assigning') : t('members.assign_button') }}
            </AtomsBaseButton>
          </form>

          <!-- Project member list -->
          <ul
            v-if="projectMembers.length > 0"
            class="divide-y divide-secondary-100 rounded-lg border border-secondary-200 dark:divide-secondary-800 dark:border-secondary-800"
          >
            <li
              v-for="pm in projectMembers"
              :key="pm.id"
              class="flex items-center gap-3 px-4 py-2.5"
            >
              <AtomsAvatar
                :src="pm.profiles?.avatar_url"
                :name="getMemberDisplayName(pm)"
                size="sm"
              />
              <div class="min-w-0 flex-1">
                <div class="truncate text-sm text-heading dark:text-secondary-100">
                  {{ getMemberDisplayName(pm) }}
                </div>
              </div>
              <AtomsBadge :variant="roleVariant[pm.role]" size="sm">
                {{ t(`members.role_${pm.role}`) }}
              </AtomsBadge>
              <AtomsIconButton
                icon="icon-[annon--trash]"
                :label="t('members.remove')"
                size="sm"
                @click="handleRemoveProjectMember(pm.id)"
              />
            </li>
          </ul>
          <div v-else class="flex items-center gap-2 rounded-lg border border-dashed border-secondary-200 px-3 py-3 dark:border-secondary-700">
            <span class="icon-[annon--user-plus] size-4 text-muted" aria-hidden="true" />
            <span class="text-xs text-muted">{{ t('members.no_project_members') }}</span>
          </div>
        </template>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { WorkspaceMember } from '~/composables/useMembers'
import { TabsContent, TabsList, TabsRoot, TabsTrigger } from 'radix-vue'

definePageMeta({
  layout: 'default',
})

const route = useRoute()
const slug = computed(() => route.params.slug as string)

const { workspaces, activeWorkspace, fetchWorkspaces, setActiveWorkspace } = useWorkspaces()
const { projects, fetchProjects } = useProjects()
const { members, projectMembers, loading: membersLoading, fetchMembers, inviteMember, updateMemberRole, removeMember, fetchProjectMembers, assignProjectMember, removeProjectMember } = useMembers()
const { t } = useContent()
const toast = useToast()

const router = useRouter()
const activeTab = ref('overview')
const saving = ref(false)
const workspaceName = ref('')
const workspaceSlug = ref('')

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

// AI Keys state
interface AIKeyInfo { id: string, provider: string, key_hint: string | null, created_at: string }
const aiKeys = ref<AIKeyInfo[]>([])
const aiKeyInput = ref('')
const aiKeySaving = ref(false)
const canByoa = computed(() => hasFeature(activeWorkspace.value?.plan, 'ai.byoa'))

async function loadSettingsData() {
  if (workspaces.value.length === 0)
    await fetchWorkspaces()

  const ws = workspaces.value.find(w => w.slug === slug.value)
  if (ws) {
    setActiveWorkspace(ws.id)
    workspaceName.value = ws.name
    workspaceSlug.value = ws.slug
    await fetchMembers(ws.id)
    await fetchProjects(ws.id)
    try {
      aiKeys.value = await $fetch<AIKeyInfo[]>(`/api/workspaces/${ws.id}/ai-keys`)
    }
    catch { aiKeys.value = [] }
  }
}

onMounted(loadSettingsData)

// Reload when workspace slug changes (SPA navigation)
watch(slug, loadSettingsData)

// Fetch project members when a project is selected
watch(assignProjectId, async (projectId) => {
  if (!projectId || !activeWorkspace.value) return
  await fetchProjectMembers(activeWorkspace.value.id, projectId)
})

const hasChanges = computed(() => {
  if (!activeWorkspace.value) return false
  return workspaceName.value !== activeWorkspace.value.name
    || workspaceSlug.value !== activeWorkspace.value.slug
})

const slugError = computed(() => {
  if (!workspaceSlug.value) return null
  const sanitized = slugify(workspaceSlug.value)
  if (sanitized !== workspaceSlug.value) return null // will be auto-sanitized
  const result = validateSlug(workspaceSlug.value)
  return result.valid ? null : result.error
})

const canSave = computed(() =>
  hasChanges.value && !slugError.value && workspaceName.value.trim().length > 0,
)

async function saveOverview() {
  if (!activeWorkspace.value || !canSave.value) return
  saving.value = true

  const newSlug = slugify(workspaceSlug.value)
  workspaceSlug.value = newSlug

  const validation = validateSlug(newSlug)
  if (!validation.valid) {
    toast.error(validation.error ?? t('settings.save_error'))
    saving.value = false
    return
  }

  try {
    await $fetch(`/api/workspaces/${activeWorkspace.value.id}`, {
      method: 'PATCH',
      body: { name: workspaceName.value.trim(), slug: newSlug },
    })
    await fetchWorkspaces()
    toast.success(t('settings.save_success'))

    if (newSlug !== slug.value) {
      await router.replace(`/w/${newSlug}/settings`)
    }
  }
  catch (e: unknown) {
    const message = e instanceof Error ? e.message : t('settings.save_error')
    toast.error(message)
  }
  finally {
    saving.value = false
  }
}

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

const wsRoleOptions = [
  { value: 'admin', label: t('members.role_admin') },
  { value: 'member', label: t('members.role_member') },
]

const workspacePlan = computed(() => activeWorkspace.value?.plan ?? 'free')
const hasPro = computed(() => hasFeature(workspacePlan.value, 'roles.reviewer'))

const projectRoleOptions = computed(() => {
  const options = [{ value: 'editor', label: t('members.role_editor') }]
  if (hasPro.value) {
    options.push(
      { value: 'reviewer', label: t('members.role_reviewer') },
      { value: 'viewer', label: t('members.role_viewer') },
    )
  }
  return options
})

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

async function handleSaveAIKey() {
  if (!activeWorkspace.value || !aiKeyInput.value.trim()) return
  aiKeySaving.value = true
  try {
    const saved = await $fetch<AIKeyInfo>(`/api/workspaces/${activeWorkspace.value.id}/ai-keys`, {
      method: 'POST',
      body: { provider: 'anthropic', apiKey: aiKeyInput.value.trim() },
    })
    aiKeys.value = aiKeys.value.filter(k => k.provider !== 'anthropic')
    aiKeys.value.push(saved)
    aiKeyInput.value = ''
    toast.success(t('ai_keys.save_success'))
  }
  catch {
    toast.error(t('ai_keys.save_error'))
  }
  finally {
    aiKeySaving.value = false
  }
}

async function handleDeleteAIKey(keyId: string) {
  if (!activeWorkspace.value) return
  try {
    await $fetch(`/api/workspaces/${activeWorkspace.value.id}/ai-keys/${keyId}`, { method: 'DELETE' })
    aiKeys.value = aiKeys.value.filter(k => k.id !== keyId)
    toast.success(t('ai_keys.delete_success'))
  }
  catch {
    toast.error(t('ai_keys.save_error'))
  }
}

// GitHub installation state
interface GitHubInstallation {
  installed: boolean
  installationId?: number
  account?: { login: string | null, avatarUrl: string | null, type: string }
  selection?: 'all' | 'selected'
  permissions?: Record<string, string>
  suspendedAt?: string | null
  repos?: Array<{ id: number, name: string, fullName: string, private: boolean, language: string | null }>
  settingsUrl?: string
  error?: string
}

const ghInstallation = ref<GitHubInstallation | null>(null)
const ghLoading = ref(false)

async function loadGitHubInstallation() {
  if (!activeWorkspace.value) return
  ghLoading.value = true
  try {
    ghInstallation.value = await $fetch<GitHubInstallation>('/api/github/installation', {
      params: { workspaceId: activeWorkspace.value.id },
    })
  }
  catch {
    ghInstallation.value = null
  }
  finally {
    ghLoading.value = false
  }
}

// Lazy-load GitHub data when tab is activated
watch(activeTab, (tab) => {
  if (tab === 'github' && !ghInstallation.value) {
    loadGitHubInstallation()
  }
})

function openGitHubSettings() {
  if (ghInstallation.value?.settingsUrl) {
    window.open(ghInstallation.value.settingsUrl, '_blank', 'noopener,noreferrer')
  }
}

function installGitHubApp() {
  window.open(
    'https://github.com/apps/contentrain-studio-dev/installations/new',
    '_blank',
    'noopener,noreferrer',
  )
}

const ghIsSuspended = computed(() => !!ghInstallation.value?.suspendedAt)
const ghHasError = computed(() => !!ghInstallation.value?.error)
const ghNeedsAttention = computed(() => ghIsSuspended.value || ghHasError.value)

const tabTriggerClass = 'px-4 py-2 text-sm font-medium text-muted transition-colors hover:text-heading data-[state=active]:text-heading data-[state=active]:border-b-2 data-[state=active]:border-primary-500 dark:text-secondary-400 dark:hover:text-secondary-100 dark:data-[state=active]:text-secondary-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50 rounded-t'
</script>

<template>
  <div class="mx-auto max-w-3xl px-6 py-8 lg:px-8">
    <AtomsHeadingText :level="1" size="lg">
      {{ t('common.settings') }}
    </AtomsHeadingText>
    <p v-if="activeWorkspace" class="mt-1 text-sm text-muted">
      {{ activeWorkspace.name }}
    </p>

    <TabsRoot v-model="activeTab" class="mt-6">
      <TabsList class="flex gap-1 border-b border-secondary-200 dark:border-secondary-800">
        <TabsTrigger value="overview" :class="tabTriggerClass">
          {{ t('settings.overview_tab') }}
        </TabsTrigger>
        <TabsTrigger value="members" :class="tabTriggerClass">
          {{ t('settings.members_tab') }}
        </TabsTrigger>
        <TabsTrigger value="github" :class="tabTriggerClass">
          {{ t('settings.github_tab') }}
        </TabsTrigger>
        <TabsTrigger value="ai-keys" :class="tabTriggerClass">
          {{ t('settings.ai_tab') }}
        </TabsTrigger>
      </TabsList>

      <!-- Overview -->
      <TabsContent value="overview" class="mt-6">
        <div class="max-w-md space-y-5">
          <div>
            <div class="flex items-center gap-1">
              <AtomsFormLabel for="ws-name" :text="t('settings.workspace_name_label')" size="sm" />
              <AtomsInfoTooltip :text="t('settings.workspace_name_info')" />
            </div>
            <AtomsFormInput
              id="ws-name"
              v-model="workspaceName"
              type="text"
              :placeholder="t('settings.workspace_name_placeholder')"
              class="mt-1.5"
            />
          </div>
          <div>
            <div class="flex items-center gap-1">
              <AtomsFormLabel for="ws-slug" :text="t('settings.slug_label')" size="sm" />
              <AtomsInfoTooltip :text="t('settings.slug_info')" />
            </div>
            <div class="mt-1.5 flex items-center gap-1 text-sm text-muted">
              <span>/w/</span>
              <AtomsFormInput
                id="ws-slug"
                v-model="workspaceSlug"
                type="text"
                :placeholder="t('settings.slug_placeholder')"
              />
            </div>
          </div>
          <div>
            <div class="flex items-center gap-1">
              <AtomsFormLabel :text="t('settings.plan_label')" size="sm" />
              <AtomsInfoTooltip :text="t('settings.plan_info')" />
            </div>
            <AtomsBadge variant="primary" size="md" class="mt-1.5">
              {{ activeWorkspace?.plan ?? 'free' }}
            </AtomsBadge>
          </div>
          <AtomsBaseButton
            variant="primary"
            size="md"
            :disabled="!canSave || saving"
            @click="saveOverview"
          >
            <span>{{ t('common.save_changes') }}</span>
          </AtomsBaseButton>
        </div>
      </TabsContent>

      <!-- Members -->
      <TabsContent value="members" class="mt-6 space-y-8">
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
                  <span v-if="!member.accepted_at" class="ml-1 text-warning-500">
                    ({{ t('members.pending') }})
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
      </TabsContent>

      <!-- GitHub -->
      <TabsContent value="github" class="mt-6">
        <div class="max-w-lg space-y-6">
          <!-- Loading -->
          <div v-if="ghLoading" class="space-y-3">
            <AtomsSkeleton variant="custom" class="h-20 w-full rounded-xl" />
            <AtomsSkeleton variant="custom" class="h-10 w-full rounded-lg" />
          </div>

          <!-- Not installed -->
          <template v-else-if="!activeWorkspace?.github_installation_id">
            <div class="rounded-xl border border-dashed border-secondary-300 p-8 text-center dark:border-secondary-700">
              <div class="mx-auto flex size-14 items-center justify-center rounded-2xl bg-secondary-50 dark:bg-secondary-900">
                <svg class="size-7 text-muted" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                  <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
                </svg>
              </div>
              <AtomsHeadingText :level="3" size="xs" class="mt-4">
                {{ t('settings.github_not_connected_title') }}
              </AtomsHeadingText>
              <p class="mt-2 text-sm text-muted">
                {{ t('settings.github_not_connected_hint') }}
              </p>
              <AtomsBaseButton variant="primary" size="md" class="mt-5" @click="installGitHubApp">
                <template #prepend>
                  <svg class="size-4" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                    <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
                  </svg>
                </template>
                {{ t('github.install_button') }}
              </AtomsBaseButton>
            </div>
          </template>

          <!-- Installed -->
          <template v-else-if="ghInstallation?.installed">
            <!-- Alert: suspended or error -->
            <div
              v-if="ghNeedsAttention"
              class="flex items-start gap-3 rounded-xl border border-danger-200 bg-danger-50 p-4 dark:border-danger-500/20 dark:bg-danger-500/10"
            >
              <span class="icon-[annon--alert-triangle] size-5 shrink-0 text-danger-500" aria-hidden="true" />
              <div class="min-w-0 flex-1">
                <p class="text-sm font-medium text-danger-700 dark:text-danger-400">
                  {{ ghIsSuspended ? t('settings.github_suspended') : t('settings.github_error') }}
                </p>
                <p class="mt-1 text-xs text-danger-600 dark:text-danger-400/80">
                  {{ ghIsSuspended ? t('settings.github_suspended_hint') : t('settings.github_error_hint') }}
                </p>
                <AtomsBaseButton variant="danger" size="sm" class="mt-3" @click="openGitHubSettings">
                  {{ t('settings.github_manage') }}
                </AtomsBaseButton>
              </div>
            </div>

            <!-- Connected account card -->
            <div
              class="flex items-center gap-4 rounded-xl border p-4"
              :class="ghNeedsAttention
                ? 'border-danger-200 dark:border-danger-500/20'
                : 'border-secondary-200 dark:border-secondary-800'"
            >
              <AtomsAvatar
                v-if="ghInstallation.account?.avatarUrl"
                :src="ghInstallation.account.avatarUrl"
                :name="ghInstallation.account.login"
                size="lg"
              />
              <div v-else class="flex size-12 items-center justify-center rounded-full bg-secondary-100 dark:bg-secondary-800">
                <svg class="size-6 text-muted" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                  <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
                </svg>
              </div>
              <div class="min-w-0 flex-1">
                <div class="flex items-center gap-2">
                  <span class="text-sm font-semibold text-heading dark:text-secondary-100">
                    {{ ghInstallation.account?.login ?? '—' }}
                  </span>
                  <AtomsBadge
                    :variant="ghInstallation.account?.type === 'Organization' ? 'info' : 'secondary'"
                    size="sm"
                  >
                    {{ ghInstallation.account?.type === 'Organization' ? t('settings.github_org') : t('settings.github_user') }}
                  </AtomsBadge>
                </div>
                <div class="mt-0.5 flex items-center gap-2 text-xs text-muted">
                  <span>{{ ghInstallation.selection === 'all' ? t('settings.github_all_repos') : t('settings.github_selected_repos') }}</span>
                  <span v-if="ghInstallation.repos" class="text-disabled">·</span>
                  <span v-if="ghInstallation.repos">{{ ghInstallation.repos.length }} {{ t('settings.github_repos_accessible') }}</span>
                </div>
              </div>
              <AtomsBadge :variant="ghNeedsAttention ? 'danger' : 'success'" size="sm">
                {{ ghNeedsAttention ? t('settings.github_attention') : t('common.connected') }}
              </AtomsBadge>
            </div>

            <!-- Actions -->
            <div class="flex items-center gap-2">
              <AtomsBaseButton size="sm" @click="openGitHubSettings">
                <template #prepend>
                  <span class="icon-[annon--external-link] size-3.5" aria-hidden="true" />
                </template>
                {{ t('settings.github_manage') }}
              </AtomsBaseButton>
              <AtomsBaseButton size="sm" @click="loadGitHubInstallation">
                <template #prepend>
                  <span class="icon-[annon--arrow-swap] size-3.5" aria-hidden="true" />
                </template>
                {{ t('settings.github_refresh') }}
              </AtomsBaseButton>
            </div>

            <!-- Accessible repos list -->
            <div v-if="ghInstallation.repos && ghInstallation.repos.length > 0 && !ghNeedsAttention">
              <div class="mb-2 flex items-center gap-1">
                <AtomsSectionLabel :label="t('settings.github_repos_title')" :count="ghInstallation.repos.length" />
                <AtomsInfoTooltip :text="t('settings.github_repos_info')" />
              </div>
              <ul class="divide-y divide-secondary-100 rounded-lg border border-secondary-200 dark:divide-secondary-800 dark:border-secondary-800">
                <li
                  v-for="repo in ghInstallation.repos" :key="repo.id"
                  class="flex items-center gap-3 px-4 py-2.5"
                >
                  <span class="icon-[annon--folder] size-4 shrink-0 text-muted" aria-hidden="true" />
                  <span class="min-w-0 flex-1 truncate text-sm text-heading dark:text-secondary-100">
                    {{ repo.name }}
                  </span>
                  <AtomsBadge v-if="repo.language" variant="secondary" size="sm">
                    {{ repo.language }}
                  </AtomsBadge>
                  <span v-if="repo.private" class="icon-[annon--lock] size-3 text-muted" aria-hidden="true" />
                </li>
              </ul>
            </div>
          </template>
        </div>
      </TabsContent>

      <!-- AI Keys -->
      <TabsContent value="ai-keys" class="mt-6">
        <div class="max-w-md space-y-5">
          <div>
            <AtomsHeadingText :level="3" size="xs">
              {{ t('ai_keys.title') }}
            </AtomsHeadingText>
            <p class="mt-1 text-sm text-muted">
              {{ t('ai_keys.description') }}
            </p>
          </div>

          <!-- Pro required -->
          <AtomsEmptyState
            v-if="!canByoa"
            illustration="/illustrations/unlock-ai.png"
            :title="t('ai_keys.pro_required_title')"
            :description="t('ai_keys.pro_required')"
            compact
          >
            <template #action>
              <AtomsBadge variant="info" size="md">
                Pro — $14/mo
              </AtomsBadge>
            </template>
          </AtomsEmptyState>

          <!-- Existing keys -->
          <ul
            v-if="aiKeys.length > 0"
            class="divide-y divide-secondary-100 rounded-lg border border-secondary-200 dark:divide-secondary-800 dark:border-secondary-800"
          >
            <li v-for="key in aiKeys" :key="key.id" class="flex items-center gap-3 px-4 py-3">
              <span class="icon-[annon--key] size-4 text-muted" aria-hidden="true" />
              <div class="min-w-0 flex-1">
                <div class="text-sm font-medium text-heading dark:text-secondary-100">
                  {{ key.provider }}
                </div>
                <div v-if="key.key_hint" class="text-xs text-muted">
                  {{ t('ai_keys.hint') }} {{ key.key_hint }}
                </div>
              </div>
              <AtomsIconButton icon="icon-[annon--trash]" label="Delete" size="sm" @click="handleDeleteAIKey(key.id)" />
            </li>
          </ul>
          <div v-else-if="canByoa">
            <AtomsEmptyState icon="icon-[annon--key]" :title="t('ai_keys.no_keys')" :description="t('ai_keys.no_keys_description')" />
          </div>

          <!-- Add key form -->
          <form v-if="canByoa" class="space-y-3" @submit.prevent="handleSaveAIKey">
            <div>
              <div class="flex items-center gap-1">
                <AtomsFormLabel :text="t('ai_keys.provider')" size="sm" />
                <AtomsInfoTooltip :text="t('ai_keys.provider_info')" />
              </div>
              <AtomsBadge variant="secondary" size="md" class="mt-1.5">
                Anthropic
              </AtomsBadge>
            </div>
            <div>
              <div class="flex items-center gap-1">
                <AtomsFormLabel for="ai-key" :text="t('ai_keys.add_key')" size="sm" />
                <AtomsInfoTooltip :text="t('ai_keys.key_info')" />
              </div>
              <AtomsFormInput
                id="ai-key"
                v-model="aiKeyInput"
                type="password"
                :placeholder="t('ai_keys.placeholder')"
                class="mt-1.5"
              />
            </div>
            <AtomsBaseButton type="submit" variant="primary" size="md" :disabled="!aiKeyInput.trim() || aiKeySaving">
              {{ aiKeySaving ? t('ai_keys.saving') : t('ai_keys.add_key') }}
            </AtomsBaseButton>
          </form>
        </div>
      </TabsContent>
    </TabsRoot>
  </div>
</template>

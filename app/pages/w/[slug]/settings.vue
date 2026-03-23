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

onMounted(async () => {
  if (workspaces.value.length === 0)
    await fetchWorkspaces()

  const ws = workspaces.value.find(w => w.slug === slug.value)
  if (ws) {
    setActiveWorkspace(ws.id)
    workspaceName.value = ws.name
    workspaceSlug.value = ws.slug
    await fetchMembers(ws.id)
    if (projects.value.length === 0)
      await fetchProjects(ws.id)
    // Fetch AI keys
    try {
      aiKeys.value = await $fetch<AIKeyInfo[]>(`/api/workspaces/${ws.id}/ai-keys`)
    }
    catch { aiKeys.value = [] }
  }
})

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
  projects.value.map(p => ({ value: p.id, label: p.repo_full_name })),
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
            <AtomsFormLabel for="ws-name" :text="t('settings.workspace_name_label')" size="sm" />
            <AtomsFormInput
              id="ws-name"
              v-model="workspaceName"
              type="text"
              :placeholder="t('settings.workspace_name_placeholder')"
              class="mt-1.5"
            />
          </div>
          <div>
            <AtomsFormLabel for="ws-slug" :text="t('settings.slug_label')" size="sm" />
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
            <AtomsFormLabel :text="t('settings.plan_label')" size="sm" />
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
          <AtomsSectionLabel :label="t('settings.members_title')" :count="members.length" class="mb-2" />

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
          <AtomsHeadingText :level="3" size="sm">
            {{ t('members.project_access') }}
          </AtomsHeadingText>
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
              <p v-else class="text-xs text-muted">
                {{ t('members.no_project_members') }}
              </p>
            </template>
          </div>
        </div>
      </TabsContent>

      <!-- GitHub -->
      <TabsContent value="github" class="mt-6">
        <div class="max-w-md space-y-5">
          <div>
            <AtomsFormLabel :text="t('settings.github_installation')" size="sm" />
            <div v-if="activeWorkspace?.github_installation_id" class="mt-1.5 flex items-center gap-2">
              <AtomsBadge variant="success" size="md">
                {{ t('common.connected') }}
              </AtomsBadge>
              <span class="text-sm text-muted">
                ID: {{ activeWorkspace.github_installation_id }}
              </span>
            </div>
            <div v-else class="mt-1.5">
              <AtomsBadge variant="warning" size="md">
                {{ t('common.not_connected') }}
              </AtomsBadge>
              <p class="mt-2 text-sm text-muted">
                {{ t('settings.github_not_connected_hint') }}
              </p>
            </div>
          </div>
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

          <!-- Pro required badge -->
          <div v-if="!canByoa" class="rounded-lg border border-info-200 bg-info-50 p-4 dark:border-info-500/20 dark:bg-info-500/10">
            <div class="flex items-center gap-2">
              <AtomsBadge variant="info" size="sm">
                Pro
              </AtomsBadge>
              <span class="text-sm text-info-700 dark:text-info-400">{{ t('ai_keys.pro_required') }}</span>
            </div>
          </div>

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
              <AtomsFormLabel :text="t('ai_keys.provider')" size="sm" />
              <AtomsBadge variant="secondary" size="md" class="mt-1.5">
                Anthropic
              </AtomsBadge>
            </div>
            <div>
              <AtomsFormLabel for="ai-key" :text="t('ai_keys.add_key')" size="sm" />
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

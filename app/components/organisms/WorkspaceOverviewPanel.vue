<script setup lang="ts">
const props = defineProps<{
  workspaceId: string
}>()

const { workspaces, activeWorkspace, fetchWorkspaces, deleteWorkspace } = useWorkspaces()
const { state: authState } = useAuth()
const { t } = useContent()
const toast = useToast()
const router = useRouter()

const saving = ref(false)
const workspaceName = ref('')
const workspaceSlug = ref('')

// Workspace deletion
const isOwner = computed(() => activeWorkspace.value?.owner_id === authState.value.user?.id)
const isSecondary = computed(() => activeWorkspace.value?.type === 'secondary')
const wsDeleteConfirmOpen = ref(false)
const wsDeleting = ref(false)

// Sync form fields when workspace changes
watch(() => activeWorkspace.value, (ws) => {
  if (ws) {
    workspaceName.value = ws.name
    workspaceSlug.value = ws.slug
  }
}, { immediate: true })

const hasChanges = computed(() => {
  if (!activeWorkspace.value) return false
  return workspaceName.value !== activeWorkspace.value.name
    || workspaceSlug.value !== activeWorkspace.value.slug
})

const slugError = computed(() => {
  if (!workspaceSlug.value) return null
  const sanitized = slugify(workspaceSlug.value)
  if (sanitized !== workspaceSlug.value) return null
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
    await $fetch(`/api/workspaces/${props.workspaceId}`, {
      method: 'PATCH',
      body: { name: workspaceName.value.trim(), slug: newSlug },
    })
    await fetchWorkspaces()
    toast.success(t('settings.save_success'))

    if (newSlug !== activeWorkspace.value!.slug) {
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

async function handleDeleteWorkspace() {
  if (!activeWorkspace.value) return
  wsDeleting.value = true
  const ok = await deleteWorkspace(activeWorkspace.value.id)
  wsDeleting.value = false

  if (ok) {
    toast.success(t('danger_zone.workspace_deleted'))
    wsDeleteConfirmOpen.value = false
    const primary = workspaces.value.find(w => w.type === 'primary')
    if (primary) router.push(`/w/${primary.slug}`)
    else router.push('/')
  }
  else {
    toast.error(t('danger_zone.workspace_delete_error'))
  }
}
</script>

<template>
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

  <!-- Danger Zone (secondary workspace, owner only) -->
  <div
    v-if="isSecondary && isOwner"
    class="mt-8 max-w-md border-t border-danger-200 pt-5 dark:border-danger-500/20"
  >
    <AtomsHeadingText :level="3" size="xs" class="text-danger-600 dark:text-danger-400">
      {{ t('danger_zone.title') }}
    </AtomsHeadingText>
    <div class="mt-3 flex items-center justify-between rounded-lg border border-danger-200 px-4 py-3 dark:border-danger-500/20">
      <div class="min-w-0 flex-1">
        <p class="text-sm font-medium text-heading dark:text-secondary-100">
          {{ t('danger_zone.workspace_delete_title') }}
        </p>
        <p class="mt-0.5 text-xs text-muted">
          {{ t('danger_zone.workspace_delete_description') }}
        </p>
      </div>
      <AtomsBaseButton variant="danger" size="sm" class="ml-4 shrink-0" @click="wsDeleteConfirmOpen = true">
        {{ t('danger_zone.workspace_delete_button') }}
      </AtomsBaseButton>
    </div>
  </div>
  <p v-else-if="activeWorkspace?.type === 'primary'" class="mt-8 max-w-md text-xs text-muted">
    {{ t('danger_zone.workspace_primary_warning') }}
  </p>

  <!-- Workspace delete confirmation -->
  <MoleculesConfirmDeleteDialog
    v-model:open="wsDeleteConfirmOpen"
    :title="t('danger_zone.workspace_delete_title')"
    :description="t('danger_zone.workspace_delete_description')"
    :confirm-text="activeWorkspace?.name ?? ''"
    :confirm-label="t('danger_zone.workspace_confirm_label')"
    :delete-label="wsDeleting ? t('danger_zone.deleting') : t('danger_zone.workspace_delete_button')"
    :deleting="wsDeleting"
    @confirm="handleDeleteWorkspace"
  />
</template>

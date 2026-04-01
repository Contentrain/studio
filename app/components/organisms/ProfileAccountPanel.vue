<script setup lang="ts">
const { state: authState, deleteAccount } = useAuth()
const { t } = useContent()
const toast = useToast()

const deleteConfirmOpen = ref(false)
const deleting = ref(false)

async function handleDeleteAccount() {
  deleting.value = true
  try {
    await deleteAccount()
    // deleteAccount navigates to /auth/login
  }
  catch {
    toast.error(t('account_settings.delete_error'))
    deleting.value = false
  }
}
</script>

<template>
  <div
    class="max-w-md border-t border-danger-200 pt-5 dark:border-danger-500/20"
  >
    <AtomsHeadingText :level="3" size="xs" class="text-danger-600 dark:text-danger-400">
      {{ t('danger_zone.title') }}
    </AtomsHeadingText>

    <div class="mt-3 rounded-lg border border-danger-200 px-4 py-3 dark:border-danger-500/20">
      <div class="flex items-center justify-between">
        <div class="min-w-0 flex-1">
          <p class="text-sm font-medium text-heading dark:text-secondary-100">
            {{ t('account_settings.delete_title') }}
          </p>
          <p class="mt-0.5 text-xs text-muted">
            {{ t('account_settings.delete_description') }}
          </p>
        </div>
        <AtomsBaseButton variant="danger" size="sm" class="ml-4 shrink-0" @click="deleteConfirmOpen = true">
          {{ t('account_settings.delete_button') }}
        </AtomsBaseButton>
      </div>
    </div>
  </div>

  <!-- Account delete confirmation -->
  <MoleculesConfirmDeleteDialog
    v-model:open="deleteConfirmOpen"
    :title="t('account_settings.delete_title')"
    :description="t('account_settings.delete_description')"
    :confirm-text="authState.user?.email ?? ''"
    :confirm-label="t('account_settings.delete_confirm_label')"
    :delete-label="deleting ? t('danger_zone.deleting') : t('account_settings.delete_button')"
    :deleting="deleting"
    @confirm="handleDeleteAccount"
  />
</template>

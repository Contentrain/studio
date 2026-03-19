<script setup lang="ts">
/**
 * Root page — redirects to the user's primary workspace.
 * Workspace selection happens in sidebar, not on a separate page.
 */
definePageMeta({
  layout: 'default',
})

const { t } = useContent()
const { workspaces, activeWorkspace, fetchWorkspaces } = useWorkspaces()

onMounted(async () => {
  if (workspaces.value.length === 0)
    await fetchWorkspaces()

  if (activeWorkspace.value) {
    await navigateTo(`/w/${activeWorkspace.value.slug}`, { replace: true })
  }
})
</script>

<template>
  <div class="flex h-full items-center justify-center">
    <div class="text-center">
      <div class="mx-auto size-6 animate-spin rounded-full border-2 border-secondary-200 border-t-primary-500 dark:border-secondary-800 dark:border-t-primary-400" />
      <p class="mt-3 text-sm text-muted">
        {{ t('common.loading_workspace') }}
      </p>
    </div>
  </div>
</template>

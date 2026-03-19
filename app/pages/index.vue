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
    <AtomsSpinner :label="t('common.loading_workspace')" />
  </div>
</template>

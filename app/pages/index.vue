<script setup lang="ts">
/**
 * Root page — redirects to the user's primary workspace.
 * Workspace selection happens in sidebar, not on a separate page.
 */
definePageMeta({
  layout: 'default',
})

const { t } = useContent()
const { workspaces, activeWorkspace, fetchWorkspaces, getLastPath, saveLastPath } = useWorkspaces()

onMounted(async () => {
  if (workspaces.value.length === 0)
    await fetchWorkspaces()

  // Resume last session — but validate the workspace slug still exists
  const lastPath = getLastPath()
  if (lastPath && lastPath !== '/') {
    const slugMatch = lastPath.match(/^\/w\/([^/]+)/)
    if (slugMatch) {
      const wsExists = workspaces.value.some(w => w.slug === slugMatch[1])
      if (wsExists) {
        await navigateTo(lastPath, { replace: true })
        return
      }
    }
    // Invalid last path — clear it
    saveLastPath('/')
  }

  // Fallback: primary workspace dashboard
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

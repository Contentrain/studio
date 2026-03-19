<script setup lang="ts">
definePageMeta({
  layout: 'default',
})

const route = useRoute()
const slug = computed(() => route.params.slug as string)

const { workspaces, activeWorkspace, fetchWorkspaces, setActiveWorkspace } = useWorkspaces()
const { projects, loading, fetchProjects } = useProjects()
const { t } = useContent()

// Ensure workspace data is loaded and active workspace is set
onMounted(async () => {
  if (workspaces.value.length === 0)
    await fetchWorkspaces()

  const ws = workspaces.value.find(w => w.slug === slug.value)
  if (ws) {
    setActiveWorkspace(ws.id)
    await fetchProjects(ws.id)
  }
})

// Re-fetch when slug changes
watch(slug, async (newSlug) => {
  const ws = workspaces.value.find(w => w.slug === newSlug)
  if (ws) {
    setActiveWorkspace(ws.id)
    await fetchProjects(ws.id)
  }
})
</script>

<template>
  <div class="mx-auto max-w-4xl px-6 py-8 lg:px-8">
    <!-- Header -->
    <div class="flex items-center justify-between">
      <div>
        <AtomsHeadingText :level="1" size="lg">
          {{ t('projects.title') }}
        </AtomsHeadingText>
        <p v-if="activeWorkspace" class="mt-1 text-sm text-muted">
          {{ projects.length }} {{ projects.length === 1 ? t('projects.count_singular') : t('projects.count_plural') }}
        </p>
      </div>
      <AtomsGhostButton
        v-if="activeWorkspace"
        size="sm"
        @click="$router.push(`/w/${activeWorkspace.slug}/projects/new`)"
      >
        <template #prepend>
          <span class="icon-[annon--plus] size-4" aria-hidden="true" />
        </template>
        {{ t('projects.connect_repo') }}
      </AtomsGhostButton>
    </div>

    <!-- Loading -->
    <div v-if="loading" class="mt-8 grid gap-4 sm:grid-cols-2">
      <div v-for="i in 4" :key="i" class="h-32 animate-pulse rounded-xl border border-secondary-200 bg-secondary-50 dark:border-secondary-800 dark:bg-secondary-900" />
    </div>

    <!-- Project Grid -->
    <div v-else-if="projects.length > 0" class="mt-6 grid gap-4 sm:grid-cols-2">
      <MoleculesProjectCard
        v-for="project in projects"
        :key="project.id"
        :project="project"
        :workspace-slug="slug"
      />
    </div>

    <!-- Empty State -->
    <div v-else class="mt-16 flex flex-col items-center text-center">
      <div class="flex size-16 items-center justify-center rounded-2xl bg-secondary-50 dark:bg-secondary-900">
        <span class="icon-[annon--link-1] text-2xl text-muted" aria-hidden="true" />
      </div>
      <AtomsHeadingText :level="2" size="sm" class="mt-5">
        {{ t('projects.empty_title') }}
      </AtomsHeadingText>
      <p class="mt-2 max-w-sm text-sm text-muted">
        {{ t('projects.empty_description') }}
      </p>
      <AtomsGhostButton
        v-if="activeWorkspace"
        size="md"
        class="mt-6"
        @click="$router.push(`/w/${activeWorkspace.slug}/projects/new`)"
      >
        <template #prepend>
          <span class="icon-[annon--plus] size-4" aria-hidden="true" />
        </template>
        {{ t('projects.connect_repo') }}
      </AtomsGhostButton>
    </div>
  </div>
</template>

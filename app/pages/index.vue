<script setup lang="ts">
definePageMeta({
  layout: 'default',
})

const { projects, loading, fetchProjects } = useProjects()
const { t } = useContent()

onMounted(() => {
  fetchProjects()
})
</script>

<template>
  <div>
    <div class="mb-6 flex items-center justify-between">
      <h2 class="text-xl font-medium text-secondary-900 dark:text-secondary-100">
        {{ t('projects.title') }}
      </h2>
      <NuxtLink
        to="/projects/new"
        class="rounded-lg bg-primary-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:opacity-90"
      >
        {{ t('projects.connect_repo') }}
      </NuxtLink>
    </div>

    <!-- Loading -->
    <div v-if="loading" class="py-12 text-center">
      <div class="mx-auto size-6 animate-spin rounded-full border-2 border-secondary-200 dark:border-secondary-800 border-t-secondary-900 dark:border-t-secondary-100" />
    </div>

    <!-- Empty state -->
    <div v-else-if="projects.length === 0" class="rounded-lg border border-dashed border-secondary-200 dark:border-secondary-800 p-12 text-center">
      <h3 class="text-base font-medium text-secondary-900 dark:text-secondary-100">
        {{ t('projects.empty_title') }}
      </h3>
      <p class="mt-2 text-sm text-muted">
        {{ t('projects.empty_description') }}
      </p>
      <NuxtLink
        to="/projects/new"
        class="mt-4 inline-block rounded-lg bg-primary-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:opacity-90"
      >
        {{ t('projects.connect_repo') }}
      </NuxtLink>
    </div>

    <!-- Project list -->
    <div v-else class="space-y-3">
      <NuxtLink
        v-for="project in projects"
        :key="project.id"
        :to="`/projects/${project.id}`"
        class="block rounded-lg border border-secondary-200 dark:border-secondary-800 p-4 transition-colors hover:border-secondary-300 dark:hover:border-secondary-700"
      >
        <div class="flex items-center justify-between">
          <div>
            <h3 class="text-sm font-medium text-secondary-900 dark:text-secondary-100">
              {{ project.repo_full_name }}
            </h3>
            <p class="mt-1 text-xs text-muted">
              {{ project.detected_stack || t('projects.unknown_stack') }} · {{ project.default_branch }}
            </p>
          </div>
          <span
            class="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium"
            :class="{
              'bg-green-50 text-green-700 dark:bg-green-950 dark:text-green-400': project.status === 'active',
              'bg-yellow-50 text-yellow-700 dark:bg-yellow-950 dark:text-yellow-400': project.status === 'setup',
              'bg-red-50 text-red-700 dark:bg-red-950 dark:text-red-400': project.status === 'error',
            }"
          >
            {{ project.status }}
          </span>
        </div>
      </NuxtLink>
    </div>
  </div>
</template>

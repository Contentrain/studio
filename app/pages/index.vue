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
      <h2 class="text-xl font-medium text-[--color-heading]">
        {{ t('projects.title') }}
      </h2>
      <NuxtLink
        to="/projects/new"
        class="rounded-lg bg-[--color-heading] px-4 py-2 text-sm font-medium text-[--color-surface] transition-colors hover:opacity-90"
      >
        {{ t('projects.connect_repo') }}
      </NuxtLink>
    </div>

    <!-- Loading -->
    <div v-if="loading" class="py-12 text-center">
      <div class="mx-auto size-6 animate-spin rounded-full border-2 border-[--color-border-default] border-t-[--color-heading]" />
    </div>

    <!-- Empty state -->
    <div v-else-if="projects.length === 0" class="rounded-lg border border-dashed border-[--color-border-default] p-12 text-center">
      <h3 class="text-base font-medium text-[--color-heading]">
        {{ t('projects.empty_title') }}
      </h3>
      <p class="mt-2 text-sm text-[--color-text-muted]">
        {{ t('projects.empty_description') }}
      </p>
      <NuxtLink
        to="/projects/new"
        class="mt-4 inline-block rounded-lg bg-[--color-heading] px-4 py-2 text-sm font-medium text-[--color-surface] transition-colors hover:opacity-90"
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
        class="block rounded-lg border border-[--color-border-default] p-4 transition-colors hover:border-[--color-border-hover]"
      >
        <div class="flex items-center justify-between">
          <div>
            <h3 class="text-sm font-medium text-[--color-heading]">
              {{ project.repo_full_name }}
            </h3>
            <p class="mt-1 text-xs text-[--color-text-muted]">
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

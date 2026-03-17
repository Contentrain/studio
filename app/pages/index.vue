<script setup lang="ts">
const { state, signOut } = useAuth()
const { projects, loading, fetchProjects } = useProjects()
const { t } = useContent()

onMounted(() => {
  fetchProjects()
})
</script>

<template>
  <div class="min-h-screen bg-white dark:bg-gray-950">
    <!-- Header -->
    <header class="border-b border-gray-200 dark:border-gray-800">
      <div class="mx-auto flex max-w-5xl items-center justify-between px-6 py-4">
        <NuxtLink to="/">
          <AtomsLogo variant="icon-text" class="h-8" />
        </NuxtLink>
        <div class="flex items-center gap-4">
          <span class="text-sm text-gray-500 dark:text-gray-400">
            {{ state.user?.email }}
          </span>
          <button
            class="text-sm text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
            @click="signOut"
          >
            {{ t('common.sign_out') }}
          </button>
        </div>
      </div>
    </header>

    <!-- Content -->
    <main class="mx-auto max-w-5xl px-6 py-8">
      <div class="mb-6 flex items-center justify-between">
        <h2 class="text-xl font-medium text-gray-900 dark:text-gray-100">
          {{ t('projects.title') }}
        </h2>
        <NuxtLink
          to="/projects/new"
          class="rounded-lg bg-gray-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-gray-800 dark:bg-gray-100 dark:text-gray-900 dark:hover:bg-gray-200"
        >
          {{ t('projects.connect_repo') }}
        </NuxtLink>
      </div>

      <!-- Loading -->
      <div v-if="loading" class="py-12 text-center">
        <div class="mx-auto h-6 w-6 animate-spin rounded-full border-2 border-gray-300 border-t-gray-900 dark:border-gray-700 dark:border-t-gray-100" />
      </div>

      <!-- Empty state -->
      <div v-else-if="projects.length === 0" class="rounded-lg border border-dashed border-gray-300 p-12 text-center dark:border-gray-700">
        <h3 class="text-base font-medium text-gray-900 dark:text-gray-100">
          {{ t('projects.empty_title') }}
        </h3>
        <p class="mt-2 text-sm text-gray-500 dark:text-gray-400">
          {{ t('projects.empty_description') }}
        </p>
        <NuxtLink
          to="/projects/new"
          class="mt-4 inline-block rounded-lg bg-gray-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-gray-800 dark:bg-gray-100 dark:text-gray-900 dark:hover:bg-gray-200"
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
          class="block rounded-lg border border-gray-200 p-4 transition-colors hover:border-gray-300 dark:border-gray-800 dark:hover:border-gray-700"
        >
          <div class="flex items-center justify-between">
            <div>
              <h3 class="text-sm font-medium text-gray-900 dark:text-gray-100">
                {{ project.repo_full_name }}
              </h3>
              <p class="mt-1 text-xs text-gray-500 dark:text-gray-400">
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
    </main>
  </div>
</template>

<script setup lang="ts">
const { state, signOut } = useAuth()
const { projects, loading, fetchProjects } = useProjects()

onMounted(() => {
  fetchProjects()
})
</script>

<template>
  <div class="min-h-screen bg-white dark:bg-gray-950">
    <!-- Header -->
    <header class="border-b border-gray-200 dark:border-gray-800">
      <div class="mx-auto max-w-5xl flex items-center justify-between px-6 py-4">
        <h1 class="text-lg font-semibold text-gray-900 dark:text-gray-100">
          Contentrain Studio
        </h1>
        <div class="flex items-center gap-4">
          <span class="text-sm text-gray-500 dark:text-gray-400">
            {{ state.user?.email }}
          </span>
          <button
            class="text-sm text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200"
            @click="signOut"
          >
            Sign out
          </button>
        </div>
      </div>
    </header>

    <!-- Content -->
    <main class="mx-auto max-w-5xl px-6 py-8">
      <div class="flex items-center justify-between mb-6">
        <h2 class="text-xl font-medium text-gray-900 dark:text-gray-100">
          Projects
        </h2>
        <NuxtLink
          to="/projects/new"
          class="rounded-lg bg-gray-900 dark:bg-gray-100 px-4 py-2 text-sm font-medium text-white dark:text-gray-900 hover:bg-gray-800 dark:hover:bg-gray-200 transition-colors"
        >
          Connect repository
        </NuxtLink>
      </div>

      <!-- Loading -->
      <div v-if="loading" class="py-12 text-center">
        <div class="h-6 w-6 animate-spin rounded-full border-2 border-gray-300 border-t-gray-900 dark:border-gray-700 dark:border-t-gray-100 mx-auto" />
      </div>

      <!-- Empty state -->
      <div v-else-if="projects.length === 0" class="rounded-lg border border-dashed border-gray-300 dark:border-gray-700 p-12 text-center">
        <div class="text-4xl mb-4">
          📦
        </div>
        <h3 class="text-base font-medium text-gray-900 dark:text-gray-100">
          No projects yet
        </h3>
        <p class="mt-2 text-sm text-gray-500 dark:text-gray-400">
          Connect a GitHub repository to start managing content.
        </p>
        <NuxtLink
          to="/projects/new"
          class="mt-4 inline-block rounded-lg bg-gray-900 dark:bg-gray-100 px-4 py-2 text-sm font-medium text-white dark:text-gray-900 hover:bg-gray-800 dark:hover:bg-gray-200 transition-colors"
        >
          Connect repository
        </NuxtLink>
      </div>

      <!-- Project list -->
      <div v-else class="space-y-3">
        <NuxtLink
          v-for="project in projects"
          :key="project.id"
          :to="`/projects/${project.id}`"
          class="block rounded-lg border border-gray-200 dark:border-gray-800 p-4 hover:border-gray-300 dark:hover:border-gray-700 transition-colors"
        >
          <div class="flex items-center justify-between">
            <div>
              <h3 class="text-sm font-medium text-gray-900 dark:text-gray-100">
                {{ project.repo_full_name }}
              </h3>
              <p class="mt-1 text-xs text-gray-500 dark:text-gray-400">
                {{ project.detected_stack || 'Unknown stack' }} · {{ project.default_branch }}
              </p>
            </div>
            <span
              class="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium"
              :class="{
                'bg-green-50 dark:bg-green-950 text-green-700 dark:text-green-400': project.status === 'active',
                'bg-yellow-50 dark:bg-yellow-950 text-yellow-700 dark:text-yellow-400': project.status === 'setup',
                'bg-red-50 dark:bg-red-950 text-red-700 dark:text-red-400': project.status === 'error',
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

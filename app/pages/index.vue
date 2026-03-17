<script setup lang="ts">
const { state, signOut } = useAuth()
</script>

<template>
  <div class="min-h-screen bg-white dark:bg-gray-950 p-8">
    <div class="max-w-2xl mx-auto">
      <div class="flex items-center justify-between mb-8">
        <h1 class="text-xl font-semibold text-gray-900 dark:text-gray-100">
          Contentrain Studio
        </h1>
        <button
          class="text-sm text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200"
          @click="signOut"
        >
          Sign out
        </button>
      </div>

      <div class="rounded-lg border border-gray-200 dark:border-gray-800 p-6">
        <p class="text-sm text-gray-600 dark:text-gray-300">
          Signed in as <strong class="text-gray-900 dark:text-gray-100">{{ state.user?.email }}</strong>
        </p>
        <p class="mt-4 text-sm text-gray-500 dark:text-gray-400">
          Project workspace coming next.
        </p>
      </div>
    </div>
  </div>
</template>

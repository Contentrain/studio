<script setup lang="ts">
const route = useRoute()

const isSignin = computed(() =>
  route.path.includes('login') || route.path.includes('forgot-password'),
)
</script>

<template>
  <div class="flex min-h-screen">
    <!-- Left: Auth form -->
    <div class="flex flex-1 flex-col px-4 py-12 sm:px-6 lg:flex-none lg:px-20 xl:px-24">
      <div class="mb-4">
        <NuxtLink to="/" class="text-lg font-semibold text-gray-900 dark:text-gray-100">
          Contentrain Studio
        </NuxtLink>
      </div>
      <div class="flex h-full flex-col justify-center">
        <div class="mx-auto w-full max-w-sm lg:w-96">
          <slot />
        </div>
      </div>
    </div>

    <!-- Right: Marketing visual -->
    <div class="relative hidden w-0 flex-1 bg-gray-50 dark:bg-gray-900 lg:block">
      <div class="flex h-full items-center justify-center px-16">
        <div class="max-w-md text-center">
          <div class="text-5xl mb-6">
            {{ isSignin ? '👋' : '🚀' }}
          </div>
          <h2 class="text-xl font-medium text-gray-900 dark:text-gray-100">
            {{ isSignin ? 'Welcome back' : 'Get started' }}
          </h2>
          <p class="mt-2 text-sm text-gray-500 dark:text-gray-400">
            {{ isSignin
              ? 'Manage your content with conversation-first workflows.'
              : 'Set up your project and start managing content in seconds.' }}
          </p>
        </div>
      </div>
    </div>
  </div>
</template>

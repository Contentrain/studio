<script setup lang="ts">
const { state, signOut } = useAuth()
const { t } = useContent()
</script>

<template>
  <div class="min-h-screen bg-white dark:bg-secondary-950">
    <!-- Header -->
    <header class="sticky top-0 z-40 border-b border-secondary-200 dark:border-secondary-800 bg-white dark:bg-secondary-950">
      <div class="mx-auto flex max-w-5xl items-center justify-between px-6 py-4">
        <NuxtLink to="/">
          <AtomsLogo variant="icon-text" class="h-8" />
        </NuxtLink>
        <div class="flex items-center gap-4">
          <span class="text-sm text-muted">
            {{ state.user?.email }}
          </span>
          <button
            class="text-sm text-muted transition-colors hover:text-secondary-900 dark:hover:text-secondary-100"
            @click="signOut"
          >
            {{ t('common.sign_out') }}
          </button>
        </div>
      </div>
    </header>

    <!-- Content -->
    <main class="mx-auto max-w-5xl px-6 py-8">
      <slot />
    </main>
  </div>
</template>

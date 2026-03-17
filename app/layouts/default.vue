<script setup lang="ts">
const { state, signOut } = useAuth()
const { t } = useContent()
</script>

<template>
  <div class="min-h-screen bg-[--color-surface]">
    <!-- Header -->
    <header class="sticky top-0 z-40 border-b border-[--color-border-default] bg-[--color-surface]">
      <div class="mx-auto flex max-w-5xl items-center justify-between px-6 py-4">
        <NuxtLink to="/">
          <AtomsLogo variant="icon-text" class="h-8" />
        </NuxtLink>
        <div class="flex items-center gap-4">
          <span class="text-sm text-[--color-text-muted]">
            {{ state.user?.email }}
          </span>
          <button
            class="text-sm text-[--color-text-muted] transition-colors hover:text-[--color-heading]"
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

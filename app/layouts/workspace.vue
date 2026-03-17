<script setup lang="ts">
const contextOpen = ref(true)

function toggleContext() {
  contextOpen.value = !contextOpen.value
}

provide('contextPanel', { open: contextOpen, toggle: toggleContext })
</script>

<template>
  <div class="flex h-screen overflow-hidden bg-white dark:bg-secondary-950">
    <!-- Sidebar -->
    <aside
      class="hidden shrink-0 flex-col border-r border-secondary-200 dark:border-secondary-800 bg-white dark:bg-secondary-950 transition-all duration-200 md:flex md:w-14 xl:w-60"
    >
      <slot name="sidebar" />
    </aside>

    <!-- Main -->
    <main class="flex min-w-0 flex-1 flex-col overflow-y-auto">
      <slot />
    </main>

    <!-- Context panel -->
    <aside
      class="hidden shrink-0 border-l border-secondary-200 dark:border-secondary-800 bg-white dark:bg-secondary-950 transition-all duration-200 lg:flex lg:flex-col"
      :class="contextOpen ? 'lg:w-[360px] xl:w-[400px]' : 'lg:w-0 lg:overflow-hidden lg:border-l-0'"
    >
      <slot name="context" />
    </aside>

    <!-- Mobile bottom tabs -->
    <nav class="fixed inset-x-0 bottom-0 z-40 border-t border-secondary-200 dark:border-secondary-800 bg-white dark:bg-secondary-950 md:hidden">
      <slot name="mobile-tabs" />
    </nav>
  </div>
</template>

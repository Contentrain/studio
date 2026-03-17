<script setup lang="ts">
const contextOpen = ref(true)

function toggleContext() {
  contextOpen.value = !contextOpen.value
}

provide('contextPanel', { open: contextOpen, toggle: toggleContext })
</script>

<template>
  <div class="flex h-screen overflow-hidden bg-[--color-surface]">
    <!-- Sidebar -->
    <aside
      class="hidden shrink-0 flex-col border-r border-[--color-border-default] bg-[--color-surface] transition-all duration-200 md:flex md:w-14 xl:w-60"
    >
      <slot name="sidebar" />
    </aside>

    <!-- Main -->
    <main class="flex min-w-0 flex-1 flex-col overflow-y-auto">
      <slot />
    </main>

    <!-- Context panel -->
    <aside
      class="hidden shrink-0 border-l border-[--color-border-default] bg-[--color-surface] transition-all duration-200 lg:flex lg:flex-col"
      :class="contextOpen ? 'lg:w-[360px] xl:w-[400px]' : 'lg:w-0 lg:overflow-hidden lg:border-l-0'"
    >
      <slot name="context" />
    </aside>

    <!-- Mobile bottom tabs -->
    <nav class="fixed inset-x-0 bottom-0 z-40 border-t border-[--color-border-default] bg-[--color-surface] md:hidden">
      <slot name="mobile-tabs" />
    </nav>
  </div>
</template>

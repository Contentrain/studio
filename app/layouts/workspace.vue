<script setup lang="ts">
const contextOpen = ref(true)
const planModalOpen = ref(false)

const { activeWorkspace } = useWorkspaces()

const trialEndsAt = computed(() => (activeWorkspace.value as { trial_ends_at?: string } | null)?.trial_ends_at ?? null)

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
      <MoleculesTrialBanner
        :trial-ends-at="trialEndsAt"
        @choose-plan="planModalOpen = true"
      />
      <slot />
    </main>

    <!-- Plan selection modal (triggered from trial banner) -->
    <OrganismsPlanSelectionModal
      :open="planModalOpen"
      @update:open="planModalOpen = $event"
    />

    <!-- Context panel -->
    <aside
      class="hidden shrink-0 border-l border-secondary-200 dark:border-secondary-800 bg-white dark:bg-secondary-950 transition-all duration-200 lg:flex lg:flex-col"
      :class="contextOpen ? 'lg:w-90 xl:w-100' : 'lg:w-0 lg:overflow-hidden lg:border-l-0'"
    >
      <slot name="context" />
    </aside>

    <!-- Mobile bottom tabs -->
    <nav
      class="fixed inset-x-0 bottom-0 z-40 border-t border-secondary-200 dark:border-secondary-800 bg-white dark:bg-secondary-950 md:hidden"
    >
      <slot name="mobile-tabs" />
    </nav>
  </div>
</template>

<script setup lang="ts">
const { t } = useContent()
const { open: commandPaletteOpen } = useCommandPalette()
const { toggle: toggleMobileSidebar } = useMobileSidebar()
const { open: planModalOpen, show: showPlanModal } = usePlanModal()
const { isLocked, openPortal } = useBilling()
const deployment = useDeployment()
const route = useRoute()

// Billing surfaces only matter inside a workspace context.
const isWorkspaceRoute = computed(() => route.path.startsWith('/w/'))

/**
 * Replace workspace content with the paywall when the active workspace
 * is locked — except on the settings route, which stays reachable so
 * the owner can still manage billing, members, or delete the workspace.
 */
const showPaywall = computed(() =>
  isLocked.value
  && deployment.hasManagedBilling.value
  && isWorkspaceRoute.value
  && !route.path.includes('/settings'),
)
</script>

<template>
  <div class="flex h-screen overflow-hidden bg-white dark:bg-secondary-950">
    <!-- Sidebar with SSR fallback skeleton (same dimensions, no content flash) -->
    <ClientOnly>
      <OrganismsAppSidebar class="hidden md:flex" />
      <template #fallback>
        <aside class="hidden h-screen w-60 shrink-0 border-r border-secondary-200 bg-white md:block dark:border-secondary-800 dark:bg-secondary-950" />
      </template>
    </ClientOnly>

    <!-- Mobile header (sidebar hidden on mobile, show minimal nav) -->
    <div class="fixed inset-x-0 top-0 z-40 flex h-14 items-center justify-between border-b border-secondary-200 bg-white px-4 md:hidden dark:border-secondary-800 dark:bg-secondary-950">
      <NuxtLink to="/" class="flex items-center gap-2">
        <AtomsLogo variant="icon" color="auto" class="h-6 w-auto" />
        <span class="text-xs font-semibold uppercase tracking-[0.2em] text-secondary-400">Studio</span>
      </NuxtLink>
      <AtomsIconButton icon="icon-[annon--menu]" :label="t('common.menu')" @click="toggleMobileSidebar" />
    </div>

    <!-- Main content (with top padding on mobile for fixed header) -->
    <main class="flex-1 overflow-y-auto pt-14 md:pt-0">
      <!-- Trial / billing-state banner (workspace routes only; hidden when
           the paywall takes over). -->
      <MoleculesTrialBanner
        v-if="isWorkspaceRoute && !showPaywall"
        @choose-plan="showPlanModal()"
        @manage-billing="openPortal()"
      />
      <OrganismsPaywallOverlay v-if="showPaywall" />
      <slot v-else />
    </main>

    <!-- Mobile sidebar drawer -->
    <ClientOnly>
      <MoleculesMobileSidebarDrawer />
    </ClientOnly>

    <!-- Command palette (⌘K) -->
    <ClientOnly>
      <OrganismsCommandPalette v-model:open="commandPaletteOpen" />
    </ClientOnly>

    <!-- Plan selection modal — opened by usePlanModal() globally on
         402 + requiresCheckout, plus any explicit upgrade CTA. Hidden
         on profiles without managed billing. -->
    <OrganismsPlanSelectionModal
      v-if="deployment.hasManagedBilling.value"
      :open="planModalOpen"
      @update:open="planModalOpen = $event"
    />
  </div>
</template>

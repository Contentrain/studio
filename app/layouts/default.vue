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

    <!-- Main content (with top padding on mobile for fixed header).
         The banner is a SIBLING of <main>, never a child: <main> is a scroll
         container, so a banner inside it either takes layout height (pushing
         full-height pages past the viewport) or scrolls away with the content. -->
    <div class="relative flex min-w-0 flex-1 flex-col pt-14 md:pt-0">
      <!-- Trial / billing-state banner (workspace routes only; hidden when
           the paywall takes over). From `md` up it leaves the flow entirely
           and floats as a compact pill, so toggling it never moves the page.
           On mobile it stays in flow — any top-anchored overlay would cover
           the chat header, and `min-h-0 flex-1` below already prevents the
           overflow this banner used to cause. -->
      <MoleculesTrialBanner
        v-if="isWorkspaceRoute && !showPaywall"
        class="shrink-0 md:absolute md:right-4 md:top-2 md:z-30 md:w-auto"
        @choose-plan="showPlanModal()"
        @manage-billing="openPortal()"
      />
      <main class="min-h-0 flex-1 overflow-y-auto">
        <OrganismsPaywallOverlay v-if="showPaywall" />
        <slot v-else />
      </main>
    </div>

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

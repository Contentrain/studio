<script setup lang="ts">
import { SplitterGroup, SplitterPanel, SplitterResizeHandle } from 'radix-vue'

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

// ── Resizable sidebar ──────────────────────────────────────
// The sidebar is on every route, so its splitter lives in the shell rather than
// in the project page's group — the two are siblings, not nested, with separate
// storage keys. Radix sizes in percent while the widths worth defending are
// pixels, so the constraints are recomputed from the measured shell width
// (see app/utils/panel-sizing.ts). Seeded from the viewport so the first paint
// is already close, then corrected by the observer.
const SHELL_MAX_PX = 1920

const shellEl = ref<HTMLElement | null>(null)
const shellWidth = ref(
  import.meta.client ? Math.min(window.innerWidth, SHELL_MAX_PX) : 0,
)
const sidebarBounds = computed(() => sidebarPanelBounds(shellWidth.value))

const sidebarPanelRef = ref<{ isCollapsed: boolean, collapse: () => void, expand: () => void } | null>(null)

let shellObserver: ResizeObserver | null = null

onMounted(() => {
  if (!shellEl.value) return
  shellObserver = new ResizeObserver(([entry]) => {
    // A zero reading is the absence of a measurement, not a measurement of
    // zero — writing it through would hand the panel a maxSize of 0, and Radix
    // persists a clamped size, so one spurious frame would leave the sidebar
    // collapsed on every later visit.
    const width = entry?.contentRect.width ?? 0
    if (width > 0) shellWidth.value = width
  })
  shellObserver.observe(shellEl.value)
})

onBeforeUnmount(() => {
  shellObserver?.disconnect()
  shellObserver = null
})

/**
 * Double-click, not click: the handle receives a click at the end of every
 * drag, so a single-click binding would collapse the sidebar the user just
 * finished sizing.
 */
function toggleSidebar() {
  const panel = sidebarPanelRef.value
  if (!panel) return
  if (panel.isCollapsed) panel.expand()
  else panel.collapse()
}

/**
 * Radix keys its saved layout as `radix-vue:<autoSaveId>`; the adapter ignores
 * the name it is handed and keeps the repo's `contentrain-` convention. Kept
 * apart from the project page's key — that layout is about one route, this one
 * follows the user everywhere.
 */
const SHELL_LAYOUT_KEY = 'contentrain-shell-panel-layout'
const shellPanelStorage = {
  getItem: () => (import.meta.client ? localStorage.getItem(SHELL_LAYOUT_KEY) : null),
  setItem: (_name: string, value: string) => {
    if (import.meta.client) localStorage.setItem(SHELL_LAYOUT_KEY, value)
  },
}
</script>

<template>
  <!-- The shell stops widening past 1920px and centres. Only the chat column
       is elastic (sidebar and content panel are fixed), so on a very wide
       display every extra pixel lands in the message bubbles and the line
       length gets hard to read. Portalled surfaces — command palette, modals,
       toasts — are `fixed` and stay centred on the viewport, which is right. -->
  <div ref="shellEl" class="mx-auto flex h-screen w-full max-w-[120rem] overflow-hidden border-x border-secondary-200 bg-white dark:border-secondary-800 dark:bg-secondary-950">
    <SplitterGroup
      direction="horizontal"
      auto-save-id="shell-panels"
      :storage="shellPanelStorage"
      class="min-w-0 flex-1"
    >
      <!-- Sidebar. Below `md` the drawer takes over and the panel is
           `display: none`, which takes it out of the flex layout entirely — so
           the group needs no separate mobile branch. -->
      <SplitterPanel
        id="sidebar"
        ref="sidebarPanelRef"
        collapsible
        :collapsed-size="0"
        :min-size="sidebarBounds.minSize"
        :max-size="sidebarBounds.maxSize"
        :default-size="sidebarBounds.defaultSize"
        class="hidden md:block"
      >
        <!-- The fallback sits INSIDE the panel so only the sidebar's contents
             swap on hydration. Wrapping the panel instead would swap the box
             that owns the width, which is what makes a restored width jump. -->
        <ClientOnly>
          <OrganismsAppSidebar />
          <template #fallback>
            <aside class="size-full border-r border-secondary-200 bg-white dark:border-secondary-800 dark:bg-secondary-950" />
          </template>
        </ClientOnly>
      </SplitterPanel>

      <!-- 1px line, ~9px grab area. The visual weight of a divider and the hit
           area of a control are different requirements; `after` gives the
           second without changing the first. -->
      <SplitterResizeHandle
        :aria-label="t('common.resize_sidebar')"
        class="relative hidden w-px shrink-0 cursor-col-resize bg-secondary-200 transition-colors after:absolute after:inset-y-0 after:-left-1 after:-right-1 after:content-[''] hover:bg-primary-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50 data-[resize-handle-state=drag]:bg-primary-500 md:block dark:bg-secondary-800"
        @dblclick="toggleSidebar"
      />

      <!-- Main content (with top padding on mobile for fixed header).
           The banner is a SIBLING of <main>, never a child: <main> is a scroll
           container, so a banner inside it either takes layout height (pushing
           full-height pages past the viewport) or scrolls away with the content. -->
      <SplitterPanel id="shell-main" class="relative flex min-w-0 flex-col pt-14 md:pt-0">
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
      </SplitterPanel>
    </SplitterGroup>

    <!-- Mobile header (sidebar hidden on mobile, show minimal nav). `fixed`, so
         it sits outside the splitter group rather than inside a sized panel. -->
    <div class="fixed inset-x-0 top-0 z-40 flex h-14 items-center justify-between border-b border-secondary-200 bg-white px-4 md:hidden dark:border-secondary-800 dark:bg-secondary-950">
      <NuxtLink to="/" class="flex items-center gap-2">
        <AtomsLogo variant="icon" color="auto" class="h-6 w-auto" />
        <span class="text-xs font-semibold uppercase tracking-[0.2em] text-secondary-400">Studio</span>
      </NuxtLink>
      <AtomsIconButton icon="icon-[annon--menu]" :label="t('common.menu')" @click="toggleMobileSidebar" />
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

<script setup lang="ts">
import { TabsContent, TabsList, TabsRoot, TabsTrigger } from 'radix-vue'

definePageMeta({
  layout: 'default',
})

const route = useRoute()
const router = useRouter()
const slug = computed(() => route.params.slug as string)

const { workspaces, activeWorkspace, fetchWorkspaces, setActiveWorkspace } = useWorkspaces()
const { isOwnerOrAdmin } = useWorkspaceRole()
const { t } = useContent()

// Workspace settings — prefix the workspace name when available so the tab is
// distinguishable from the account-level /settings page.
useHead({
  title: () => activeWorkspace.value?.name
    ? `${activeWorkspace.value.name} · ${t('common.settings')}`
    : t('common.settings'),
})

// AI tab hosts the member's own Anthropic key (BYOA) — `ai.byoa` is ee-backed. One gating rule:
// hidden in Community (the route would 404), otherwise shown, with an upgrade call to action
// when the plan lacks it.
const aiGate = useFeatureGate('ai.byoa')

const validTabs = computed(() => {
  const base = ['overview', 'members', 'billing', 'github', 'connected-apps'] as const
  return aiGate.value !== 'hidden' ? [...base, 'ai'] as const : base
})

// Old deep links (docs, bookmarks, the previous palette entries) keep working.
const LEGACY_TAB_ALIASES: Record<string, string> = {
  'ai-keys': 'ai',
  'mcp-cloud': 'connected-apps',
}

watch(() => route.query.tab, (tab) => {
  const alias = typeof tab === 'string' ? LEGACY_TAB_ALIASES[tab] : undefined
  if (alias) router.replace({ query: { ...route.query, tab: alias } })
}, { immediate: true })

const tabFromQuery = computed(() => {
  const raw = route.query.tab as string | undefined
  const tab = raw ? (LEGACY_TAB_ALIASES[raw] ?? raw) : undefined
  return tab && (validTabs.value as readonly string[]).includes(tab) ? tab : null
})

const activeTab = ref<string>(tabFromQuery.value ?? 'overview')

// Deep-link: sync tab from ?tab= query param
watch(tabFromQuery, (tab) => {
  if (tab) activeTab.value = tab
})

// If the active tab becomes unavailable (e.g. user lands on ?tab=ai
// in Community), fall back to overview.
watch(validTabs, (tabs) => {
  if (!(tabs as readonly string[]).includes(activeTab.value)) activeTab.value = 'overview'
}, { immediate: true })

const toast = useToast()

async function loadSettingsData() {
  if (workspaces.value.length === 0)
    await fetchWorkspaces()

  const ws = workspaces.value.find(w => w.slug === slug.value)
  if (ws) {
    setActiveWorkspace(ws.id)
  }
}

onMounted(async () => {
  await loadSettingsData()

  // Handle payment provider checkout return
  const billing = route.query.billing as string | undefined
  if (billing === 'success') {
    activeTab.value = 'billing'
    // Refresh to pick up webhook updates
    await fetchWorkspaces()
    toast.success(t('billing.checkout_success'))
  }
  else if (billing === 'cancelled') {
    activeTab.value = 'billing'
  }
})
watch(slug, loadSettingsData)

// On a narrow screen the tab strip scrolls: keep the active tab in view, and fade the right edge while more tabs hide there.
const tabStrip = ref<{ $el: HTMLElement } | null>(null)
const moreToTheRight = ref(false)

function updateStripHint() {
  const el = tabStrip.value?.$el
  moreToTheRight.value = !!el && el.scrollLeft + el.clientWidth < el.scrollWidth - 4
}

function revealActiveTab() {
  const el = tabStrip.value?.$el
  el?.querySelector<HTMLElement>('[data-state="active"]')?.scrollIntoView?.({ inline: 'center', block: 'nearest' })
  updateStripHint()
}

watch(activeTab, () => nextTick(revealActiveTab))
onMounted(() => nextTick(revealActiveTab))

const tabTriggerClass = 'shrink-0 snap-start whitespace-nowrap px-4 py-2 text-sm font-medium text-muted transition-colors hover:text-heading data-[state=active]:text-heading data-[state=active]:border-b-2 data-[state=active]:border-primary-500 dark:text-secondary-400 dark:hover:text-secondary-100 dark:data-[state=active]:text-secondary-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50 rounded-t'
</script>

<template>
  <div class="mx-auto max-w-3xl px-6 py-8 lg:px-8">
    <AtomsHeadingText :level="1" size="lg">
      {{ t('common.settings') }}
    </AtomsHeadingText>
    <p v-if="activeWorkspace" class="mt-1 text-sm text-muted">
      {{ activeWorkspace.name }}
    </p>

    <TabsRoot v-model="activeTab" class="mt-6">
      <TabsList
        ref="tabStrip"
        class="flex snap-x gap-1 overflow-x-auto border-b border-secondary-200 dark:border-secondary-800"
        :class="moreToTheRight ? '[mask-image:linear-gradient(to_right,black_calc(100%-2.5rem),transparent)]' : ''"
        data-testid="settings-tab-strip"
        @scroll.passive="updateStripHint"
      >
        <TabsTrigger value="overview" :class="tabTriggerClass">
          {{ t('settings.overview_tab') }}
        </TabsTrigger>
        <TabsTrigger v-if="isOwnerOrAdmin" value="members" :class="tabTriggerClass">
          {{ t('settings.members_tab') }}
        </TabsTrigger>
        <!-- Every member sees Billing: the plan and what is used. Actions stay
             with owners and admins (the panel says so). -->
        <TabsTrigger value="billing" :class="tabTriggerClass">
          {{ t('settings.billing_tab') }}
        </TabsTrigger>
        <TabsTrigger v-if="isOwnerOrAdmin" value="github" :class="tabTriggerClass">
          {{ t('settings.github_tab') }}
        </TabsTrigger>
        <TabsTrigger value="connected-apps" :class="tabTriggerClass">
          {{ t('settings.connected_apps_tab') }}
        </TabsTrigger>
        <TabsTrigger v-if="aiGate !== 'hidden'" value="ai" :class="tabTriggerClass">
          {{ t('settings.ai_tab') }}
        </TabsTrigger>
      </TabsList>

      <TabsContent value="overview" class="mt-6">
        <OrganismsWorkspaceOverviewPanel v-if="activeWorkspace" :workspace-id="activeWorkspace.id" />
      </TabsContent>

      <TabsContent v-if="isOwnerOrAdmin" value="members" class="mt-6">
        <OrganismsWorkspaceMembersPanel v-if="activeWorkspace" :workspace-id="activeWorkspace.id" />
      </TabsContent>

      <TabsContent value="billing" class="mt-6">
        <OrganismsWorkspaceBillingPanel v-if="activeWorkspace" :workspace-id="activeWorkspace.id" />
      </TabsContent>

      <TabsContent v-if="isOwnerOrAdmin" value="github" class="mt-6">
        <OrganismsWorkspaceGitHubPanel v-if="activeWorkspace" :workspace-id="activeWorkspace.id" />
      </TabsContent>

      <TabsContent value="connected-apps" class="mt-6">
        <OrganismsWorkspaceConnectedAppsPanel v-if="activeWorkspace" :workspace-id="activeWorkspace.id" />
      </TabsContent>

      <TabsContent v-if="aiGate !== 'hidden'" value="ai" class="mt-6">
        <OrganismsWorkspaceAIKeysPanel v-if="activeWorkspace" :workspace-id="activeWorkspace.id" :locked="aiGate === 'locked'" />
      </TabsContent>
    </TabsRoot>
  </div>
</template>

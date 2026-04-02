<script setup lang="ts">
import { TabsContent, TabsList, TabsRoot, TabsTrigger } from 'radix-vue'

definePageMeta({
  layout: 'default',
})

const route = useRoute()
const slug = computed(() => route.params.slug as string)

const { workspaces, activeWorkspace, fetchWorkspaces, setActiveWorkspace } = useWorkspaces()
const { isOwnerOrAdmin } = useWorkspaceRole()
const { t } = useContent()

const validTabs = ['overview', 'members', 'billing', 'github', 'ai-keys'] as const
const tabFromQuery = computed(() => {
  const tab = route.query.tab as string | undefined
  return tab && (validTabs as readonly string[]).includes(tab) ? tab : null
})

const activeTab = ref(tabFromQuery.value ?? 'overview')

// Deep-link: sync tab from ?tab= query param
watch(tabFromQuery, (tab) => {
  if (tab) activeTab.value = tab
})

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

  // Handle Stripe checkout return
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

const tabTriggerClass = 'px-4 py-2 text-sm font-medium text-muted transition-colors hover:text-heading data-[state=active]:text-heading data-[state=active]:border-b-2 data-[state=active]:border-primary-500 dark:text-secondary-400 dark:hover:text-secondary-100 dark:data-[state=active]:text-secondary-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50 rounded-t'
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
      <TabsList class="flex gap-1 border-b border-secondary-200 dark:border-secondary-800">
        <TabsTrigger value="overview" :class="tabTriggerClass">
          {{ t('settings.overview_tab') }}
        </TabsTrigger>
        <TabsTrigger v-if="isOwnerOrAdmin" value="members" :class="tabTriggerClass">
          {{ t('settings.members_tab') }}
        </TabsTrigger>
        <TabsTrigger v-if="isOwnerOrAdmin" value="billing" :class="tabTriggerClass">
          {{ t('settings.billing_tab') }}
        </TabsTrigger>
        <TabsTrigger v-if="isOwnerOrAdmin" value="github" :class="tabTriggerClass">
          {{ t('settings.github_tab') }}
        </TabsTrigger>
        <TabsTrigger value="ai-keys" :class="tabTriggerClass">
          {{ t('settings.ai_tab') }}
        </TabsTrigger>
      </TabsList>

      <TabsContent value="overview" class="mt-6">
        <OrganismsWorkspaceOverviewPanel v-if="activeWorkspace" :workspace-id="activeWorkspace.id" />
      </TabsContent>

      <TabsContent v-if="isOwnerOrAdmin" value="members" class="mt-6">
        <OrganismsWorkspaceMembersPanel v-if="activeWorkspace" :workspace-id="activeWorkspace.id" />
      </TabsContent>

      <TabsContent v-if="isOwnerOrAdmin" value="billing" class="mt-6">
        <OrganismsWorkspaceBillingPanel v-if="activeWorkspace" :workspace-id="activeWorkspace.id" />
      </TabsContent>

      <TabsContent v-if="isOwnerOrAdmin" value="github" class="mt-6">
        <OrganismsWorkspaceGitHubPanel v-if="activeWorkspace" :workspace-id="activeWorkspace.id" />
      </TabsContent>

      <TabsContent value="ai-keys" class="mt-6">
        <OrganismsWorkspaceAIKeysPanel v-if="activeWorkspace" :workspace-id="activeWorkspace.id" />
      </TabsContent>
    </TabsRoot>
  </div>
</template>

<script setup lang="ts">
import { TabsContent, TabsList, TabsRoot, TabsTrigger } from 'radix-vue'

definePageMeta({
  layout: 'default',
})

const route = useRoute()
const slug = computed(() => route.params.slug as string)

const { workspaces, activeWorkspace, fetchWorkspaces, setActiveWorkspace } = useWorkspaces()
const { t } = useContent()

const activeTab = ref('overview')

async function loadSettingsData() {
  if (workspaces.value.length === 0)
    await fetchWorkspaces()

  const ws = workspaces.value.find(w => w.slug === slug.value)
  if (ws) {
    setActiveWorkspace(ws.id)
  }
}

onMounted(loadSettingsData)
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
        <TabsTrigger value="members" :class="tabTriggerClass">
          {{ t('settings.members_tab') }}
        </TabsTrigger>
        <TabsTrigger value="github" :class="tabTriggerClass">
          {{ t('settings.github_tab') }}
        </TabsTrigger>
        <TabsTrigger value="ai-keys" :class="tabTriggerClass">
          {{ t('settings.ai_tab') }}
        </TabsTrigger>
      </TabsList>

      <TabsContent value="overview" class="mt-6">
        <OrganismsWorkspaceOverviewPanel v-if="activeWorkspace" :workspace-id="activeWorkspace.id" />
      </TabsContent>

      <TabsContent value="members" class="mt-6">
        <OrganismsWorkspaceMembersPanel v-if="activeWorkspace" :workspace-id="activeWorkspace.id" />
      </TabsContent>

      <TabsContent value="github" class="mt-6">
        <OrganismsWorkspaceGitHubPanel v-if="activeWorkspace" :workspace-id="activeWorkspace.id" />
      </TabsContent>

      <TabsContent value="ai-keys" class="mt-6">
        <OrganismsWorkspaceAIKeysPanel v-if="activeWorkspace" :workspace-id="activeWorkspace.id" />
      </TabsContent>
    </TabsRoot>
  </div>
</template>

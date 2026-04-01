<script setup lang="ts">
import { TabsContent, TabsList, TabsRoot, TabsTrigger } from 'radix-vue'

definePageMeta({
  layout: 'default',
})

const route = useRoute()
const { t } = useContent()

const validTabs = ['profile', 'account'] as const
const tabFromQuery = computed(() => {
  const tab = route.query.tab as string | undefined
  return tab && (validTabs as readonly string[]).includes(tab) ? tab : null
})

const activeTab = ref(tabFromQuery.value ?? 'profile')

// Deep-link: sync tab from ?tab= query param
watch(tabFromQuery, (tab) => {
  if (tab) activeTab.value = tab
})

const tabTriggerClass = 'px-4 py-2 text-sm font-medium text-muted transition-colors hover:text-heading data-[state=active]:text-heading data-[state=active]:border-b-2 data-[state=active]:border-primary-500 dark:text-secondary-400 dark:hover:text-secondary-100 dark:data-[state=active]:text-secondary-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50 rounded-t'
</script>

<template>
  <div class="mx-auto max-w-3xl px-6 py-8 lg:px-8">
    <AtomsHeadingText :level="1" size="lg">
      {{ t('account_settings.title') }}
    </AtomsHeadingText>
    <p class="mt-1 text-sm text-muted">
      {{ t('account_settings.description') }}
    </p>

    <TabsRoot v-model="activeTab" class="mt-6">
      <TabsList class="flex gap-1 border-b border-secondary-200 dark:border-secondary-800">
        <TabsTrigger value="profile" :class="tabTriggerClass">
          {{ t('account_settings.profile_tab') }}
        </TabsTrigger>
        <TabsTrigger value="account" :class="tabTriggerClass">
          {{ t('account_settings.account_tab') }}
        </TabsTrigger>
      </TabsList>

      <TabsContent value="profile" class="mt-6">
        <OrganismsProfileOverviewPanel />
      </TabsContent>

      <TabsContent value="account" class="mt-6">
        <OrganismsProfileAccountPanel />
      </TabsContent>
    </TabsRoot>
  </div>
</template>

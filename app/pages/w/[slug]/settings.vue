<script setup lang="ts">
import { TabsContent, TabsList, TabsRoot, TabsTrigger } from 'radix-vue'

definePageMeta({
  layout: 'default',
})

const route = useRoute()
const slug = computed(() => route.params.slug as string)

const { workspaces, activeWorkspace, fetchWorkspaces, setActiveWorkspace } = useWorkspaces()
const { t } = useContent()
const toast = useToast()

const activeTab = ref('overview')
const saving = ref(false)
const workspaceName = ref('')

onMounted(async () => {
  if (workspaces.value.length === 0)
    await fetchWorkspaces()

  const ws = workspaces.value.find(w => w.slug === slug.value)
  if (ws) {
    setActiveWorkspace(ws.id)
    workspaceName.value = ws.name
  }
})

const hasChanges = computed(() =>
  activeWorkspace.value && workspaceName.value !== activeWorkspace.value.name,
)

async function saveOverview() {
  if (!activeWorkspace.value || !hasChanges.value) return
  saving.value = true
  try {
    await $fetch(`/api/workspaces/${activeWorkspace.value.id}`, {
      method: 'PATCH',
      body: { name: workspaceName.value },
    })
    // Update local state
    await fetchWorkspaces()
    toast.success(t('settings.save_success'))
  }
  catch (e: unknown) {
    const message = e instanceof Error ? e.message : t('settings.save_error')
    toast.error(message)
  }
  finally {
    saving.value = false
  }
}

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
      </TabsList>

      <!-- Overview -->
      <TabsContent value="overview" class="mt-6">
        <div class="max-w-md space-y-5">
          <div>
            <AtomsFormLabel for="ws-name" :text="t('settings.workspace_name_label')" size="sm" />
            <AtomsFormInput
              id="ws-name"
              v-model="workspaceName"
              type="text"
              :placeholder="t('settings.workspace_name_placeholder')"
              class="mt-1.5"
            />
          </div>
          <div>
            <AtomsFormLabel :text="t('settings.slug_label')" size="sm" />
            <p class="mt-1.5 text-sm text-muted">
              {{ activeWorkspace?.slug }}
            </p>
          </div>
          <div>
            <AtomsFormLabel :text="t('settings.plan_label')" size="sm" />
            <AtomsBadge variant="primary" size="md" class="mt-1.5">
              {{ activeWorkspace?.plan ?? 'free' }}
            </AtomsBadge>
          </div>
          <AtomsBaseButton
            variant="primary"
            size="md"
            :disabled="!hasChanges || saving"
            @click="saveOverview"
          >
            <span>{{ t('common.save_changes') }}</span>
          </AtomsBaseButton>
        </div>
      </TabsContent>

      <!-- Members -->
      <TabsContent value="members" class="mt-6">
        <AtomsEmptyState
          icon="icon-[annon--users]"
          :title="t('settings.members_title')"
          :description="t('settings.members_description')"
        />
      </TabsContent>

      <!-- GitHub -->
      <TabsContent value="github" class="mt-6">
        <div class="max-w-md space-y-5">
          <div>
            <AtomsFormLabel :text="t('settings.github_installation')" size="sm" />
            <div v-if="activeWorkspace?.github_installation_id" class="mt-1.5 flex items-center gap-2">
              <AtomsBadge variant="success" size="md">
                {{ t('common.connected') }}
              </AtomsBadge>
              <span class="text-sm text-muted">
                ID: {{ activeWorkspace.github_installation_id }}
              </span>
            </div>
            <div v-else class="mt-1.5">
              <AtomsBadge variant="warning" size="md">
                {{ t('common.not_connected') }}
              </AtomsBadge>
              <p class="mt-2 text-sm text-muted">
                {{ t('settings.github_not_connected_hint') }}
              </p>
            </div>
          </div>
        </div>
      </TabsContent>
    </TabsRoot>
  </div>
</template>

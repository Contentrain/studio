<script setup lang="ts">
const props = defineProps<{
  workspaceId: string
}>()

const { t } = useContent()
const toast = useToast()

interface ConnectedGrant {
  grantId: string
  clientHost: string | null
  clientName: string | null
  logoUri: string | null
  projectId: string
  projectRepo: string | null
  scopes: string[]
  createdAt: string
  lastUsedAt: string | null
  callsThisMonth: number
  mine: boolean
}

interface ConnectedAppsResponse {
  enabled: boolean
  endpoint: string | null
  grants: ConnectedGrant[]
}

const loading = ref(true)
const enabled = ref(true)
const endpoint = ref<string | null>(null)
const grants = ref<ConnectedGrant[]>([])

const hasRemoteMcp = useFeature('api.mcp_cloud_oauth')

const claudeCommand = computed(() =>
  endpoint.value ? `claude mcp add --transport http contentrain ${endpoint.value}` : '',
)

async function refresh() {
  loading.value = true
  try {
    const response = await $fetch<ConnectedAppsResponse>(`/api/workspaces/${props.workspaceId}/connected-apps`)
    enabled.value = response.enabled
    endpoint.value = response.endpoint
    grants.value = response.grants
  }
  catch {
    grants.value = []
  }
  finally {
    loading.value = false
  }
}

onMounted(refresh)

function copyToClipboard(value: string) {
  if (!value) return
  navigator.clipboard?.writeText(value).then(() => toast.success(t('mcp_cloud.copied')))
}

async function handleRevoke(grantId: string) {
  if (!window.confirm(t('connected_apps.revoke_confirm'))) return
  try {
    await $fetch(`/api/workspaces/${props.workspaceId}/connected-apps/${grantId}`, { method: 'DELETE' })
    grants.value = grants.value.filter(grant => grant.grantId !== grantId)
    toast.success(t('connected_apps.revoke_success'))
  }
  catch {
    toast.error(t('connected_apps.revoke_error'))
  }
}

function formatRelative(iso: string | null): string {
  if (!iso) return t('connected_apps.never_used')
  return t('connected_apps.last_used', { when: new Date(iso).toLocaleString() })
}
</script>

<template>
  <div class="max-w-3xl space-y-6">
    <div>
      <AtomsHeadingText :level="3" size="xs">
        {{ t('connected_apps.title') }}
      </AtomsHeadingText>
      <p class="mt-1 text-sm text-muted">
        {{ t('connected_apps.description') }}
      </p>
    </div>

    <div v-if="!hasRemoteMcp" class="rounded-lg border border-warning-200 bg-warning-50 p-4 dark:border-warning-800 dark:bg-warning-900/20">
      <p class="text-sm text-warning-800 dark:text-warning-200">
        {{ t('connected_apps.upgrade_cta') }}
      </p>
    </div>

    <div v-else-if="!loading && !enabled" class="rounded-lg border border-border p-4 dark:border-secondary-800">
      <p class="text-sm text-muted">
        {{ t('connected_apps.managed_only') }}
      </p>
    </div>

    <template v-else>
      <div v-if="endpoint" class="rounded-lg border border-border p-4 dark:border-secondary-800">
        <AtomsFormLabel :text="t('connected_apps.endpoint_label')" size="sm" />
        <div class="mt-1.5 flex items-center gap-2">
          <code class="block flex-1 truncate rounded bg-secondary-50 px-3 py-2 font-mono text-xs text-heading dark:bg-secondary-900 dark:text-secondary-100">
            {{ endpoint }}
          </code>
          <AtomsIconButton
            icon="icon-[annon--copy]"
            :label="t('mcp_cloud.copy_endpoint')"
            size="sm"
            @click="copyToClipboard(endpoint)"
          />
        </div>
        <p class="mt-2 text-xs text-muted">
          {{ t('connected_apps.endpoint_help') }}
        </p>
        <div class="mt-3">
          <AtomsFormLabel :text="t('connected_apps.connect_claude_code_label')" size="sm" />
          <div class="mt-1.5 flex items-start gap-2">
            <code class="block flex-1 overflow-x-auto whitespace-pre rounded bg-secondary-50 px-3 py-2 font-mono text-xs text-heading dark:bg-secondary-900 dark:text-secondary-100">{{ claudeCommand }}</code>
            <AtomsIconButton
              icon="icon-[annon--copy]"
              :label="t('mcp_cloud.copy_command')"
              size="sm"
              @click="copyToClipboard(claudeCommand)"
            />
          </div>
        </div>
      </div>

      <ul
        v-if="!loading && grants.length > 0"
        class="divide-y divide-secondary-100 rounded-lg border border-secondary-200 dark:divide-secondary-800 dark:border-secondary-800"
      >
        <li v-for="grant in grants" :key="grant.grantId" class="flex items-center gap-3 px-4 py-3">
          <NuxtImg
            v-if="grant.logoUri"
            :src="grant.logoUri"
            :alt="grant.clientHost ?? ''"
            class="size-8 shrink-0 rounded border border-border object-contain dark:border-secondary-800"
          />
          <span v-else class="icon-[annon--plug] size-4 shrink-0 text-muted" aria-hidden="true" />
          <div class="min-w-0 flex-1">
            <div class="flex items-center gap-2">
              <span class="truncate text-sm font-medium text-heading dark:text-secondary-100">
                {{ grant.clientHost ?? grant.clientName ?? grant.grantId }}
              </span>
              <AtomsBadge v-if="grant.mine" variant="secondary" size="sm">
                {{ t('connected_apps.connected_by_you') }}
              </AtomsBadge>
            </div>
            <div class="truncate text-xs text-muted">
              <span v-if="grant.clientName && grant.clientName !== grant.clientHost">{{ grant.clientName }} · </span>
              <span v-if="grant.projectRepo">{{ grant.projectRepo }} · </span>
              {{ formatRelative(grant.lastUsedAt) }}
              · {{ t('connected_apps.usage_this_month', { count: grant.callsThisMonth }) }}
            </div>
            <div class="mt-1 flex flex-wrap gap-1">
              <span
                v-for="scope in grant.scopes"
                :key="scope"
                class="rounded bg-secondary-100 px-1.5 py-0.5 font-mono text-[10px] text-secondary-600 dark:bg-secondary-800 dark:text-secondary-300"
              >
                {{ scope }}
              </span>
            </div>
          </div>
          <AtomsIconButton
            icon="icon-[annon--trash]"
            :label="t('connected_apps.revoke')"
            size="sm"
            @click="handleRevoke(grant.grantId)"
          />
        </li>
      </ul>
      <div v-else-if="!loading">
        <AtomsEmptyState
          icon="icon-[annon--plug]"
          :title="t('connected_apps.empty_title')"
          :description="t('connected_apps.empty_description')"
        />
      </div>
    </template>
  </div>
</template>

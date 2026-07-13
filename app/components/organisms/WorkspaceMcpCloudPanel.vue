<script setup lang="ts">
import { DialogClose, DialogContent, DialogDescription, DialogOverlay, DialogPortal, DialogRoot, DialogTitle } from 'radix-vue'

const props = defineProps<{
  workspaceId: string
}>()

const { t } = useContent()
const toast = useToast()

interface McpCloudKey {
  id: string
  name: string
  key_prefix: string
  project_id: string
  allowed_tools: string[]
  media_enabled: boolean
  rate_limit_per_minute: number
  monthly_call_limit: number | null
  last_used_at: string | null
  created_at: string
  calls_this_month: number
}

interface ProjectLite {
  id: string
  name: string
  repo_full_name: string
}

const keys = ref<McpCloudKey[]>([])
const projects = ref<ProjectLite[]>([])
const loading = ref(true)

const newKeyName = ref('')
const newKeyProjectId = ref<string>('')
const newKeyMediaEnabled = ref(false)
const creating = ref(false)

const revealedKey = ref<string | null>(null)
const revealedProjectId = ref<string | null>(null)
const revealDialogOpen = ref(false)

const hasMcpCloud = useFeature('api.mcp_cloud')

function mcpEndpointUrl(projectId: string): string {
  if (typeof window === 'undefined') return ''
  return `${window.location.origin}/api/mcp/v1/${projectId}/mcp`
}

const endpointTemplate = computed(() => mcpEndpointUrl('{projectId}'))

const revealedEndpoint = computed(() =>
  revealedProjectId.value ? mcpEndpointUrl(revealedProjectId.value) : '',
)

const claudeCommand = computed(() => {
  if (!revealedKey.value || !revealedEndpoint.value) return ''
  return `claude mcp add --transport http contentrain ${revealedEndpoint.value} --header "Authorization: Bearer ${revealedKey.value}"`
})

const jsonConfig = computed(() => {
  if (!revealedKey.value || !revealedEndpoint.value) return ''
  return JSON.stringify({
    mcpServers: {
      contentrain: {
        type: 'http',
        url: revealedEndpoint.value,
        headers: { Authorization: `Bearer ${revealedKey.value}` },
      },
    },
  }, null, 2)
})

const projectOptions = computed(() =>
  projects.value.map(p => ({ value: p.id, label: p.name ?? p.repo_full_name })),
)

async function refresh() {
  loading.value = true
  try {
    const [keyRes, projectRes] = await Promise.all([
      $fetch<{ keys: McpCloudKey[] }>(`/api/workspaces/${props.workspaceId}/mcp-cloud-keys`),
      $fetch<ProjectLite[]>(`/api/workspaces/${props.workspaceId}/projects`),
    ])
    keys.value = keyRes.keys
    projects.value = projectRes
    if (!newKeyProjectId.value && projects.value[0]) {
      newKeyProjectId.value = projects.value[0].id
    }
  }
  catch {
    keys.value = []
  }
  finally {
    loading.value = false
  }
}

onMounted(refresh)

function projectLabel(projectId: string): string {
  const project = projects.value.find(p => p.id === projectId)
  return project?.name ?? project?.repo_full_name ?? projectId
}

function copyToClipboard(value: string) {
  if (!value) return
  navigator.clipboard?.writeText(value).then(() => toast.success(t('mcp_cloud.copied')))
}

async function handleCreate() {
  if (!newKeyName.value.trim() || !newKeyProjectId.value) return
  creating.value = true
  try {
    const created = await $fetch<{ key: string } & McpCloudKey>(
      `/api/workspaces/${props.workspaceId}/mcp-cloud-keys`,
      {
        method: 'POST',
        body: {
          name: newKeyName.value.trim(),
          projectId: newKeyProjectId.value,
          mediaEnabled: newKeyMediaEnabled.value,
        },
      },
    )
    revealedKey.value = created.key
    revealedProjectId.value = created.project_id ?? newKeyProjectId.value
    revealDialogOpen.value = true
    newKeyName.value = ''
    newKeyMediaEnabled.value = false
    toast.success(t('mcp_cloud.create_success'))
    await refresh()
  }
  catch {
    toast.error(t('mcp_cloud.create_error'))
  }
  finally {
    creating.value = false
  }
}

async function handleRevoke(keyId: string) {
  if (!window.confirm(t('mcp_cloud.revoke_confirm'))) return
  try {
    await $fetch(`/api/workspaces/${props.workspaceId}/mcp-cloud-keys/${keyId}`, { method: 'DELETE' })
    keys.value = keys.value.filter(k => k.id !== keyId)
    toast.success(t('mcp_cloud.revoke_success'))
  }
  catch {
    toast.error(t('mcp_cloud.create_error'))
  }
}

function formatRelative(iso: string | null): string {
  if (!iso) return t('mcp_cloud.never_used')
  const date = new Date(iso)
  return t('mcp_cloud.last_used', { when: date.toLocaleString() })
}
</script>

<template>
  <div class="max-w-3xl space-y-6">
    <div>
      <AtomsHeadingText :level="3" size="xs">
        {{ t('mcp_cloud.title') }}
      </AtomsHeadingText>
      <p class="mt-1 text-sm text-muted">
        {{ t('mcp_cloud.description') }}
      </p>
    </div>

    <div v-if="!hasMcpCloud" class="rounded-lg border border-warning-200 bg-warning-50 p-4 dark:border-warning-800 dark:bg-warning-900/20">
      <p class="text-sm text-warning-800 dark:text-warning-200">
        {{ t('mcp_cloud.upgrade_cta') }}
      </p>
    </div>

    <template v-else>
      <div class="rounded-lg border border-border p-4 dark:border-secondary-800">
        <AtomsFormLabel :text="t('mcp_cloud.endpoint_label')" size="sm" />
        <div class="mt-1.5 flex items-center gap-2">
          <code class="block flex-1 truncate rounded bg-secondary-50 px-3 py-2 font-mono text-xs text-heading dark:bg-secondary-900 dark:text-secondary-100">
            {{ endpointTemplate }}
          </code>
          <AtomsIconButton
            icon="icon-[annon--copy]"
            :label="t('mcp_cloud.copy_endpoint')"
            size="sm"
            @click="copyToClipboard(endpointTemplate)"
          />
        </div>
        <p class="mt-2 text-xs text-muted">
          {{ t('mcp_cloud.endpoint_help') }}
        </p>
      </div>

      <ul
        v-if="!loading && keys.length > 0"
        class="divide-y divide-secondary-100 rounded-lg border border-secondary-200 dark:divide-secondary-800 dark:border-secondary-800"
      >
        <li v-for="key in keys" :key="key.id" class="flex items-center gap-3 px-4 py-3">
          <span class="icon-[annon--key] size-4 text-muted" aria-hidden="true" />
          <div class="min-w-0 flex-1">
            <div class="flex items-center gap-2">
              <span class="truncate text-sm font-medium text-heading dark:text-secondary-100">
                {{ key.name }}
              </span>
              <AtomsBadge v-if="key.media_enabled" variant="info" size="sm">
                {{ t('mcp_cloud.media_badge') }}
              </AtomsBadge>
            </div>
            <div class="text-xs text-muted">
              <span class="font-mono">{{ key.key_prefix }}…</span>
              · {{ projectLabel(key.project_id) }}
              · {{ formatRelative(key.last_used_at) }}
              · {{ t('mcp_cloud.usage_this_month', { count: key.calls_this_month ?? 0 }) }}
            </div>
          </div>
          <AtomsIconButton
            icon="icon-[annon--copy]"
            :label="t('mcp_cloud.copy_endpoint')"
            size="sm"
            @click="copyToClipboard(mcpEndpointUrl(key.project_id))"
          />
          <AtomsIconButton
            icon="icon-[annon--trash]"
            :label="t('mcp_cloud.revoke')"
            size="sm"
            @click="handleRevoke(key.id)"
          />
        </li>
      </ul>
      <div v-else-if="!loading">
        <AtomsEmptyState
          icon="icon-[annon--key]"
          :title="t('mcp_cloud.no_keys')"
          :description="t('mcp_cloud.no_keys_description')"
        />
      </div>

      <form class="space-y-3 rounded-lg border border-border p-4 dark:border-secondary-800" @submit.prevent="handleCreate">
        <div>
          <AtomsFormLabel for="mcp-key-name" :text="t('mcp_cloud.name_label')" size="sm" />
          <AtomsFormInput
            id="mcp-key-name"
            v-model="newKeyName"
            :placeholder="t('mcp_cloud.name_placeholder')"
            class="mt-1.5"
          />
        </div>
        <div>
          <AtomsFormLabel for="mcp-key-project" :text="t('mcp_cloud.project_label')" size="sm" />
          <AtomsFormSelect
            id="mcp-key-project"
            v-model="newKeyProjectId"
            :options="projectOptions"
            :placeholder="t('mcp_cloud.select_project')"
            class="mt-1.5"
          />
        </div>
        <div>
          <AtomsFormSwitch
            :model-value="newKeyMediaEnabled"
            :label="t('mcp_cloud.media_enabled_label')"
            @update:model-value="newKeyMediaEnabled = $event"
          />
          <p class="mt-1 text-xs text-muted">
            {{ t('mcp_cloud.media_enabled_hint') }}
          </p>
        </div>
        <AtomsBaseButton type="submit" variant="primary" size="md" :disabled="!newKeyName.trim() || !newKeyProjectId || creating">
          {{ creating ? t('mcp_cloud.creating') : t('mcp_cloud.create') }}
        </AtomsBaseButton>
      </form>
    </template>

    <DialogRoot v-model:open="revealDialogOpen">
      <DialogPortal>
        <DialogOverlay class="fixed inset-0 z-50 bg-black/50" />
        <DialogContent class="fixed left-1/2 top-1/2 z-50 max-h-[85vh] w-[min(560px,92vw)] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-lg bg-white p-6 shadow-xl dark:bg-secondary-900">
          <DialogTitle class="text-lg font-semibold text-heading dark:text-secondary-100">
            {{ t('mcp_cloud.key_created_title') }}
          </DialogTitle>
          <DialogDescription class="mt-2 text-sm text-muted">
            {{ t('mcp_cloud.key_created_warning') }}
          </DialogDescription>
          <div class="mt-4 flex items-center gap-2">
            <code class="block flex-1 overflow-x-auto rounded bg-secondary-50 px-3 py-2 font-mono text-xs text-heading dark:bg-secondary-900 dark:text-secondary-100">
              {{ revealedKey }}
            </code>
            <AtomsIconButton
              icon="icon-[annon--copy]"
              :label="t('mcp_cloud.copy_key')"
              size="sm"
              @click="copyToClipboard(revealedKey ?? '')"
            />
          </div>

          <div class="mt-5 space-y-4">
            <p class="text-sm font-medium text-heading dark:text-secondary-100">
              {{ t('mcp_cloud.connect_title') }}
            </p>
            <div>
              <AtomsFormLabel :text="t('mcp_cloud.connect_claude_label')" size="sm" />
              <div class="mt-1.5 flex items-start gap-2">
                <code class="block max-h-24 flex-1 overflow-auto whitespace-pre-wrap break-all rounded bg-secondary-50 px-3 py-2 font-mono text-xs text-heading dark:bg-secondary-900 dark:text-secondary-100">{{ claudeCommand }}</code>
                <AtomsIconButton
                  icon="icon-[annon--copy]"
                  :label="t('mcp_cloud.copy_command')"
                  size="sm"
                  @click="copyToClipboard(claudeCommand)"
                />
              </div>
            </div>
            <div>
              <AtomsFormLabel :text="t('mcp_cloud.connect_json_label')" size="sm" />
              <div class="mt-1.5 flex items-start gap-2">
                <code class="block max-h-40 flex-1 overflow-auto whitespace-pre rounded bg-secondary-50 px-3 py-2 font-mono text-xs text-heading dark:bg-secondary-900 dark:text-secondary-100">{{ jsonConfig }}</code>
                <AtomsIconButton
                  icon="icon-[annon--copy]"
                  :label="t('mcp_cloud.copy_config')"
                  size="sm"
                  @click="copyToClipboard(jsonConfig)"
                />
              </div>
            </div>
          </div>

          <div class="mt-6 flex justify-end">
            <DialogClose as-child>
              <AtomsBaseButton variant="primary" size="md">
                {{ t('mcp_cloud.close') }}
              </AtomsBaseButton>
            </DialogClose>
          </div>
        </DialogContent>
      </DialogPortal>
    </DialogRoot>
  </div>
</template>

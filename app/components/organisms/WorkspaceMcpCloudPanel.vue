<script setup lang="ts">
import { DialogClose, DialogContent, DialogDescription, DialogOverlay, DialogPortal, DialogRoot, DialogTitle } from 'radix-vue'

const props = defineProps<{
  workspaceId: string
}>()

const { t } = useContent()
const toast = useToast()
const { activeWorkspace } = useWorkspaces()

interface McpCloudKey {
  id: string
  name: string
  key_prefix: string
  project_id: string
  allowed_tools: string[]
  rate_limit_per_minute: number
  monthly_call_limit: number | null
  last_used_at: string | null
  created_at: string
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
const creating = ref(false)

const revealedKey = ref<string | null>(null)
const revealDialogOpen = ref(false)

const plan = computed(() => (activeWorkspace.value?.plan ?? 'free') as string)
const hasMcpCloud = computed(() => ['starter', 'pro', 'enterprise'].includes(plan.value))

const endpointUrl = computed(() => {
  if (typeof window === 'undefined') return ''
  return `${window.location.origin}/api/mcp/v1/{projectId}`
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
        },
      },
    )
    revealedKey.value = created.key
    revealDialogOpen.value = true
    newKeyName.value = ''
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
            {{ endpointUrl }}
          </code>
          <AtomsIconButton
            icon="icon-[annon--copy]"
            :label="t('mcp_cloud.copy_endpoint')"
            size="sm"
            @click="copyToClipboard(endpointUrl)"
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
            <div class="truncate text-sm font-medium text-heading dark:text-secondary-100">
              {{ key.name }}
            </div>
            <div class="text-xs text-muted">
              <span class="font-mono">{{ key.key_prefix }}…</span>
              · {{ projectLabel(key.project_id) }}
              · {{ formatRelative(key.last_used_at) }}
            </div>
          </div>
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
        <AtomsBaseButton type="submit" variant="primary" size="md" :disabled="!newKeyName.trim() || !newKeyProjectId || creating">
          {{ creating ? t('mcp_cloud.creating') : t('mcp_cloud.create') }}
        </AtomsBaseButton>
      </form>
    </template>

    <DialogRoot v-model:open="revealDialogOpen">
      <DialogPortal>
        <DialogOverlay class="fixed inset-0 z-50 bg-black/50" />
        <DialogContent class="fixed left-1/2 top-1/2 z-50 w-[min(480px,92vw)] -translate-x-1/2 -translate-y-1/2 rounded-lg bg-white p-6 shadow-xl dark:bg-secondary-900">
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

<script setup lang="ts">
import { DialogClose, DialogContent, DialogDescription, DialogOverlay, DialogPortal, DialogRoot, DialogTitle } from 'radix-vue'

const props = defineProps<{
  workspaceId: string
  projectId: string
}>()

const { t } = useContent()
const toast = useToast()
const { isOwnerOrAdmin } = useWorkspaceRole()

interface McpCloudKey {
  id: string
  name: string
  key_prefix: string
  project_id: string
  media_enabled: boolean
  last_used_at: string | null
  calls_this_month: number
}

// The list route returns every key of the workspace (the quota is per workspace); this panel shows
// the ones of its own project and uses the full count for the "N of M" line.
const allKeys = ref<McpCloudKey[]>([])
const loading = ref(true)

const newKeyName = ref('')
const newKeyMediaEnabled = ref(false)
const creating = ref(false)
const confirmRevokeId = ref<string | null>(null)
const revoking = ref<string | null>(null)

const revealedKey = ref<string | null>(null)
const revealDialogOpen = ref(false)

const keyLimit = useFeatureLimit('api.mcp_keys')

const projectKeys = computed(() => allKeys.value.filter(k => k.project_id === props.projectId))

const quotaLine = computed(() => {
  const used = allKeys.value.length
  return Number.isFinite(keyLimit.value)
    ? t('mcp_cloud.key_quota', { used, limit: keyLimit.value })
    : t('mcp_cloud.key_quota_unlimited', { used })
})

const endpointUrl = computed(() =>
  typeof window === 'undefined' ? '' : `${window.location.origin}/api/mcp/v1/${props.projectId}/mcp`,
)

// Server name "contentrain-<project>" keeps a key-based entry from colliding with the OAuth
// "contentrain-remote" entry the Connected apps tab shows.
const serverName = computed(() => `contentrain-${props.projectId.slice(0, 8)}`)

const claudeCommand = computed(() => {
  if (!revealedKey.value || !endpointUrl.value) return ''
  return `claude mcp add --transport http ${serverName.value} ${endpointUrl.value} --header "Authorization: Bearer ${revealedKey.value}"`
})

const jsonConfig = computed(() => {
  if (!revealedKey.value || !endpointUrl.value) return ''
  return JSON.stringify({
    mcpServers: {
      [serverName.value]: {
        type: 'http',
        url: endpointUrl.value,
        headers: { Authorization: `Bearer ${revealedKey.value}` },
      },
    },
  }, null, 2)
})

async function refresh() {
  loading.value = true
  try {
    const res = await $fetch<{ keys: McpCloudKey[] }>(`/api/workspaces/${props.workspaceId}/mcp-cloud-keys`)
    allKeys.value = res.keys
  }
  catch {
    allKeys.value = []
  }
  finally {
    loading.value = false
  }
}

watch([() => props.workspaceId, () => props.projectId], ([ws, proj]) => {
  if (ws && proj) refresh()
}, { immediate: true })

function copyToClipboard(value: string) {
  if (!value) return
  navigator.clipboard?.writeText(value).then(() => toast.success(t('mcp_cloud.copied')))
}

async function handleCreate() {
  if (!newKeyName.value.trim()) return
  creating.value = true
  try {
    const created = await $fetch<{ key: string }>(
      `/api/workspaces/${props.workspaceId}/mcp-cloud-keys`,
      {
        method: 'POST',
        body: {
          name: newKeyName.value.trim(),
          projectId: props.projectId,
          mediaEnabled: newKeyMediaEnabled.value,
        },
      },
    )
    revealedKey.value = created.key
    revealDialogOpen.value = true
    newKeyName.value = ''
    newKeyMediaEnabled.value = false
    toast.success(t('mcp_cloud.create_success'))
    await refresh()
  }
  catch (e) {
    toast.error(resolveApiError(e, t('mcp_cloud.create_error')))
  }
  finally {
    creating.value = false
  }
}

async function handleRevoke(keyId: string) {
  revoking.value = keyId
  try {
    await $fetch(`/api/workspaces/${props.workspaceId}/mcp-cloud-keys/${keyId}`, { method: 'DELETE' })
    allKeys.value = allKeys.value.filter(k => k.id !== keyId)
    toast.success(t('mcp_cloud.revoke_success'))
  }
  catch {
    toast.error(t('mcp_cloud.revoke_error'))
  }
  finally {
    revoking.value = null
    confirmRevokeId.value = null
  }
}

function formatRelative(iso: string | null): string {
  if (!iso) return t('mcp_cloud.never_used')
  return t('mcp_cloud.last_used', { when: new Date(iso).toLocaleString() })
}
</script>

<template>
  <section class="space-y-4" data-testid="project-mcp-keys">
    <div>
      <h3 class="text-sm font-semibold text-heading dark:text-secondary-100">
        {{ t('mcp_cloud.section_title') }}
      </h3>
      <p class="mt-0.5 text-xs text-muted">
        {{ t('mcp_cloud.description') }}
      </p>
    </div>

    <div class="rounded-lg border border-border p-3 dark:border-secondary-800">
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

    <p v-if="!loading" class="text-xs text-muted" data-testid="mcp-key-quota">
      {{ quotaLine }}
    </p>

    <ul
      v-if="!loading && projectKeys.length > 0"
      class="divide-y divide-secondary-100 rounded-lg border border-secondary-200 dark:divide-secondary-800 dark:border-secondary-800"
    >
      <li v-for="key in projectKeys" :key="key.id" class="flex items-center gap-3 px-4 py-3">
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
            · {{ formatRelative(key.last_used_at) }}
            · {{ t('mcp_cloud.usage_this_month', { count: key.calls_this_month ?? 0 }) }}
          </div>
        </div>
        <template v-if="isOwnerOrAdmin">
          <AtomsIconButton
            v-if="confirmRevokeId !== key.id"
            icon="icon-[annon--trash]"
            :label="t('mcp_cloud.revoke')"
            size="sm"
            @click="confirmRevokeId = key.id"
          />
          <div v-else class="flex items-center gap-1">
            <AtomsBaseButton variant="danger" size="sm" :disabled="revoking === key.id" data-testid="mcp-key-confirm-revoke" @click="handleRevoke(key.id)">
              {{ t('common.revoke') }}
            </AtomsBaseButton>
            <AtomsBaseButton variant="ghost" size="sm" @click="confirmRevokeId = null">
              {{ t('common.cancel') }}
            </AtomsBaseButton>
          </div>
        </template>
      </li>
    </ul>
    <AtomsEmptyState
      v-else-if="!loading"
      icon="icon-[annon--key]"
      :title="t('mcp_cloud.no_keys')"
      :description="t('mcp_cloud.no_keys_description')"
      compact
    />

    <form v-if="isOwnerOrAdmin" class="space-y-3 rounded-lg border border-border p-4 dark:border-secondary-800" @submit.prevent="handleCreate">
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
        <AtomsFormSwitch
          :model-value="newKeyMediaEnabled"
          :label="t('mcp_cloud.media_enabled_label')"
          @update:model-value="newKeyMediaEnabled = $event"
        />
        <p class="mt-1 text-xs text-muted">
          {{ t('mcp_cloud.media_enabled_hint') }}
        </p>
      </div>
      <AtomsBaseButton type="submit" variant="primary" size="md" :disabled="!newKeyName.trim() || creating">
        {{ creating ? t('mcp_cloud.creating') : t('mcp_cloud.create') }}
      </AtomsBaseButton>
    </form>
    <p v-else class="text-xs text-muted" data-testid="mcp-keys-admin-note">
      {{ t('mcp_cloud.managed_by_admins') }}
    </p>

    <DialogRoot v-model:open="revealDialogOpen">
      <DialogPortal>
        <DialogOverlay class="fixed inset-0 z-[60] bg-black/50" />
        <DialogContent class="fixed left-1/2 top-1/2 z-[60] max-h-[85vh] w-[min(560px,92vw)] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-lg bg-white p-6 shadow-xl dark:bg-secondary-900">
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
  </section>
</template>

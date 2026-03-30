<script setup lang="ts">
import {
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogOverlay,
  DialogPortal,
  DialogRoot,
  DialogTitle,
} from 'radix-vue'

const { t } = useContent()
const toast = useToast()
const { activeWorkspace } = useWorkspaces()
const { isOwnerOrAdmin } = useWorkspaceRole()

const props = defineProps<{
  workspaceId: string
  projectId: string
}>()

const hasPlan = computed(() => hasFeature(activeWorkspace.value?.plan, 'api.conversation'))
const canManage = computed(() => hasPlan.value && isOwnerOrAdmin.value)

interface ConversationKey {
  id: string
  name: string
  keyPrefix: string
  role: string
  specificModels: boolean
  allowedModels: string[]
  allowedTools: string[]
  allowedLocales: string[]
  customInstructions: string | null
  aiModel: string
  rateLimitPerMinute: number
  monthlyMessageLimit: number
  monthlyUsage: number
  lastUsedAt: string | null
  createdAt: string
  revokedAt: string | null
  key?: string
}

const keys = ref<ConversationKey[]>([])
const loading = ref(true)
const createOpen = ref(false)
const creating = ref(false)
const revoking = ref<string | null>(null)
const confirmRevokeId = ref<string | null>(null)

// Create form state
const newName = ref('')
const newRole = ref('editor')

// Newly created key (shown once)
const createdKey = ref<string | null>(null)
const copied = ref(false)

const activeKeys = computed(() => keys.value.filter(k => !k.revokedAt))

const roleVariant: Record<string, 'info' | 'primary' | 'warning'> = {
  viewer: 'info',
  editor: 'primary',
  admin: 'warning',
}

async function loadKeys() {
  if (!props.workspaceId || !props.projectId) return
  loading.value = true
  if (!hasPlan.value) {
    loading.value = false
    return
  }
  try {
    keys.value = await $fetch<ConversationKey[]>(
      `/api/workspaces/${props.workspaceId}/projects/${props.projectId}/conversation-keys`,
    )
  }
  catch (e) {
    // eslint-disable-next-line no-console
    console.error('[ConversationKeysPanel] Load error:', e)
  }
  finally {
    loading.value = false
  }
}

watch(
  [() => props.workspaceId, () => props.projectId],
  ([ws, proj]) => {
    if (ws && proj) loadKeys()
  },
  { immediate: true },
)

async function createKey() {
  if (!newName.value.trim()) return
  creating.value = true
  try {
    const result = await $fetch<ConversationKey>(
      `/api/workspaces/${props.workspaceId}/projects/${props.projectId}/conversation-keys`,
      {
        method: 'POST',
        body: {
          name: newName.value.trim(),
          role: newRole.value,
        },
      },
    )
    keys.value.unshift(result)
    createdKey.value = result.key ?? null
    newName.value = ''
    newRole.value = 'editor'
    createOpen.value = false
    toast.success(t('conversation_keys.created'))
  }
  catch {
    toast.error(t('conversation_keys.create_error'))
  }
  finally {
    creating.value = false
  }
}

async function revokeKey(keyId: string) {
  revoking.value = keyId
  try {
    await $fetch(
      `/api/workspaces/${props.workspaceId}/projects/${props.projectId}/conversation-keys/${keyId}`,
      { method: 'DELETE' },
    )
    keys.value = keys.value.map(k =>
      k.id === keyId ? { ...k, revokedAt: new Date().toISOString() } : k,
    )
    toast.success(t('conversation_keys.revoked'))
  }
  catch {
    toast.error(t('conversation_keys.revoke_error'))
  }
  finally {
    revoking.value = null
    confirmRevokeId.value = null
  }
}

function copyKey() {
  if (!createdKey.value) return
  navigator.clipboard.writeText(createdKey.value)
  copied.value = true
  toast.success(t('common.copied'))
  setTimeout(() => {
    copied.value = false
  }, 2000)
}

function dismissKey() {
  createdKey.value = null
  copied.value = false
}

function formatRelativeTime(dateStr: string | null): string {
  if (!dateStr) return t('conversation_keys.never_used')
  const diff = Date.now() - new Date(dateStr).getTime()
  const minutes = Math.floor(diff / 60_000)
  if (minutes < 60) return t('time.minutes_ago').replace('{count}', String(Math.max(1, minutes)))
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return t('time.hours_ago').replace('{count}', String(hours))
  const days = Math.floor(hours / 24)
  return t('time.days_ago').replace('{count}', String(days))
}

// Reset create form when dialog opens
watch(createOpen, (isOpen) => {
  if (isOpen) {
    newName.value = ''
    newRole.value = 'editor'
  }
})
</script>

<template>
  <div class="flex h-full flex-col">
    <!-- Loading -->
    <div v-if="loading" class="space-y-3 p-5">
      <AtomsSkeleton v-for="i in 3" :key="i" variant="custom" class="h-14 w-full rounded-lg" />
    </div>

    <!-- Upgrade nudge -->
    <div v-else-if="!hasPlan" class="flex h-full items-center justify-center p-8">
      <AtomsEmptyState
        icon="icon-[annon--comment-2-text]"
        :title="t('conversation_keys.title')"
        :description="t('conversation_keys.description')"
      >
        <template #action>
          <AtomsBadge variant="info" size="md">
            Business
          </AtomsBadge>
        </template>
      </AtomsEmptyState>
    </div>

    <!-- Keys Management -->
    <div v-else class="flex-1 overflow-y-auto">
      <!-- Header -->
      <div class="flex items-center justify-between border-b border-secondary-200 px-5 py-3 dark:border-secondary-800">
        <div>
          <div class="text-sm font-medium text-heading dark:text-secondary-100">
            {{ t('conversation_keys.title') }}
          </div>
          <p class="text-xs text-muted">
            {{ t('conversation_keys.description') }}
          </p>
        </div>
        <AtomsBaseButton v-if="canManage" variant="primary" size="sm" @click="createOpen = true">
          <template #prepend>
            <span class="icon-[annon--plus] size-3.5" aria-hidden="true" />
          </template>
          {{ t('conversation_keys.create') }}
        </AtomsBaseButton>
      </div>

      <!-- Newly created key alert -->
      <div v-if="createdKey" class="mx-5 mt-4 rounded-lg border border-warning-200 bg-warning-50 p-3 dark:border-warning-500/20 dark:bg-warning-500/10">
        <div class="flex items-start justify-between gap-2">
          <div class="flex items-center gap-2">
            <span class="icon-[annon--alert-triangle] size-4 shrink-0 text-warning-500" aria-hidden="true" />
            <p class="text-xs font-medium text-warning-700 dark:text-warning-400">
              {{ t('conversation_keys.copy_warning') }}
            </p>
          </div>
          <button
            type="button"
            class="shrink-0 rounded-md p-0.5 text-muted transition-colors hover:text-heading focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50 dark:hover:text-secondary-100"
            @click="dismissKey"
          >
            <span class="icon-[annon--cross] block size-3" aria-hidden="true" />
          </button>
        </div>
        <div class="mt-2 flex items-center gap-2">
          <code class="flex-1 truncate rounded bg-white px-2 py-1 font-mono text-[11px] text-heading dark:bg-secondary-900 dark:text-secondary-100">
            {{ createdKey }}
          </code>
          <AtomsBaseButton variant="ghost" size="sm" @click="copyKey">
            <span
              :class="copied ? 'icon-[annon--check]' : 'icon-[annon--copy]'"
              class="size-3.5"
              aria-hidden="true"
            />
          </AtomsBaseButton>
        </div>
      </div>

      <!-- Keys list -->
      <div class="px-5 pt-4 pb-5">
        <div class="mb-2 flex items-center gap-1">
          <AtomsSectionLabel :label="t('conversation_keys.title')" :count="activeKeys.length" />
        </div>

        <div v-if="activeKeys.length > 0" class="space-y-1.5">
          <div
            v-for="key in activeKeys"
            :key="key.id"
            class="rounded-lg border border-secondary-200 px-3 py-2.5 dark:border-secondary-800"
          >
            <div class="flex items-center gap-2">
              <span class="icon-[annon--key] size-3.5 shrink-0 text-muted" aria-hidden="true" />
              <div class="min-w-0 flex-1">
                <div class="flex items-center gap-2">
                  <span class="truncate text-xs font-medium text-heading dark:text-secondary-100">
                    {{ key.name }}
                  </span>
                  <AtomsBadge :variant="roleVariant[key.role] ?? 'secondary'" size="sm">
                    {{ key.role }}
                  </AtomsBadge>
                </div>
                <div class="mt-0.5 flex items-center gap-3">
                  <span class="font-mono text-[10px] text-muted">
                    {{ key.keyPrefix }}...
                  </span>
                  <span class="text-[10px] text-disabled">
                    {{ key.lastUsedAt ? `${t('conversation_keys.last_used')} ${formatRelativeTime(key.lastUsedAt)}` : t('conversation_keys.never_used') }}
                  </span>
                </div>
              </div>

              <!-- Revoke -->
              <div v-if="canManage" class="shrink-0">
                <button
                  v-if="confirmRevokeId !== key.id"
                  type="button"
                  class="rounded px-1.5 py-0.5 text-[10px] font-medium text-danger-500 transition-colors hover:bg-danger-50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-danger-500/50 dark:hover:bg-danger-900/20"
                  @click="confirmRevokeId = key.id"
                >
                  {{ t('conversation_keys.revoke') }}
                </button>
                <div v-else class="flex items-center gap-1">
                  <AtomsBaseButton
                    variant="danger"
                    size="sm"
                    :disabled="revoking === key.id"
                    @click="revokeKey(key.id)"
                  >
                    <template v-if="revoking === key.id" #prepend>
                      <div class="size-3 animate-spin rounded-full border-2 border-white/30 border-t-white" />
                    </template>
                    {{ t('common.delete') }}
                  </AtomsBaseButton>
                  <AtomsBaseButton variant="ghost" size="sm" @click="confirmRevokeId = null">
                    {{ t('common.cancel') }}
                  </AtomsBaseButton>
                </div>
              </div>
            </div>
          </div>
        </div>

        <!-- Empty state -->
        <div v-else class="py-8">
          <AtomsEmptyState
            icon="icon-[annon--key]"
            :title="t('conversation_keys.no_keys')"
            :description="t('conversation_keys.no_keys_description')"
            compact
          >
            <template v-if="canManage" #action>
              <AtomsBaseButton variant="primary" size="sm" @click="createOpen = true">
                <template #prepend>
                  <span class="icon-[annon--plus] size-3.5" aria-hidden="true" />
                </template>
                {{ t('conversation_keys.create') }}
              </AtomsBaseButton>
            </template>
          </AtomsEmptyState>
        </div>
      </div>
    </div>

    <!-- Create API Key Dialog -->
    <DialogRoot v-model:open="createOpen">
      <DialogPortal>
        <DialogOverlay
          class="fixed inset-0 z-50 bg-black/50 data-[state=open]:animate-in data-[state=open]:fade-in data-[state=closed]:animate-out data-[state=closed]:fade-out"
        />
        <DialogContent
          class="fixed left-1/2 top-1/2 z-50 w-full max-w-md -translate-x-1/2 -translate-y-1/2 rounded-xl border border-secondary-200 bg-white shadow-xl dark:border-secondary-800 dark:bg-secondary-950"
          @interact-outside.prevent
        >
          <!-- Dialog Header -->
          <div class="flex items-center justify-between border-b border-secondary-200 px-5 py-4 dark:border-secondary-800">
            <DialogTitle class="text-base font-semibold text-heading dark:text-secondary-100">
              {{ t('conversation_keys.create') }}
            </DialogTitle>
            <DialogClose
              class="rounded-md p-1 text-muted transition-colors hover:bg-secondary-100 hover:text-heading focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50 dark:hover:bg-secondary-800 dark:hover:text-secondary-100"
            >
              <span class="icon-[annon--cross] block size-4" aria-hidden="true" />
            </DialogClose>
          </div>
          <DialogDescription class="sr-only">
            {{ t('conversation_keys.create') }}
          </DialogDescription>

          <!-- Dialog Body -->
          <form class="space-y-4 px-5 py-4" @submit.prevent="createKey">
            <!-- Name -->
            <div>
              <AtomsFormLabel for="conv-key-name" :text="t('conversation_keys.name')" size="sm" required />
              <AtomsFormInput
                id="conv-key-name"
                v-model="newName"
                type="text"
                :placeholder="t('conversation_keys.name_placeholder')"
                class="mt-1.5"
                required
              />
            </div>

            <!-- Role -->
            <div>
              <AtomsFormLabel for="conv-key-role" :text="t('conversation_keys.role')" size="sm" />
              <AtomsFormSelect
                :model-value="newRole"
                :options="[
                  { value: 'viewer', label: 'Viewer' },
                  { value: 'editor', label: 'Editor' },
                  { value: 'admin', label: 'Admin' },
                ]"
                size="md"
                class="mt-1.5"
                @update:model-value="newRole = $event"
              />
            </div>

            <!-- Footer -->
            <div class="flex items-center justify-end gap-2 border-t border-secondary-200 pt-4 dark:border-secondary-800">
              <DialogClose as-child>
                <AtomsBaseButton variant="ghost" size="sm">
                  {{ t('common.cancel') }}
                </AtomsBaseButton>
              </DialogClose>
              <AtomsBaseButton type="submit" variant="primary" size="sm" :disabled="!newName.trim() || creating">
                <template v-if="creating" #prepend>
                  <div class="size-3.5 animate-spin rounded-full border-2 border-white/30 border-t-white" />
                </template>
                {{ creating ? t('conversation_keys.creating') : t('conversation_keys.create') }}
              </AtomsBaseButton>
            </div>
          </form>
        </DialogContent>
      </DialogPortal>
    </DialogRoot>
  </div>
</template>

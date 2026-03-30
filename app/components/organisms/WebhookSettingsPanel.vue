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

const hasPlan = computed(() => hasFeature(activeWorkspace.value?.plan, 'api.webhooks_outbound'))
const canManage = computed(() => hasPlan.value && isOwnerOrAdmin.value)

interface Webhook {
  id: string
  name: string
  url: string
  events: string[]
  active: boolean
  created_at: string
  updated_at: string | null
  secret: string | null
}

const AVAILABLE_EVENTS = [
  'content.saved',
  'content.deleted',
  'model.saved',
  'branch.merged',
  'branch.rejected',
  'cdn.build_complete',
  'media.uploaded',
  'form.submitted',
] as const

const webhooks = ref<Webhook[]>([])
const loading = ref(true)
const createOpen = ref(false)
const creating = ref(false)
const testing = ref<string | null>(null)
const deleting = ref<string | null>(null)
const confirmDeleteId = ref<string | null>(null)

// Create form state
const newName = ref('')
const newUrl = ref('')
const newEvents = ref<string[]>([])

// Newly created webhook secret (shown once)
const createdSecret = ref<string | null>(null)
const copied = ref(false)

async function loadWebhooks() {
  if (!props.workspaceId || !props.projectId) return
  loading.value = true
  if (!hasPlan.value) {
    loading.value = false
    return
  }
  try {
    webhooks.value = await $fetch<Webhook[]>(
      `/api/workspaces/${props.workspaceId}/projects/${props.projectId}/webhooks`,
    )
  }
  catch (e) {
    // eslint-disable-next-line no-console
    console.error('[WebhookSettingsPanel] Load error:', e)
  }
  finally {
    loading.value = false
  }
}

watch(
  [() => props.workspaceId, () => props.projectId],
  ([ws, proj]) => {
    if (ws && proj) loadWebhooks()
  },
  { immediate: true },
)

async function createWebhook() {
  if (!newName.value.trim() || !newUrl.value.trim() || newEvents.value.length === 0) return
  creating.value = true
  try {
    const result = await $fetch<Webhook & { secret: string }>(
      `/api/workspaces/${props.workspaceId}/projects/${props.projectId}/webhooks`,
      {
        method: 'POST',
        body: {
          name: newName.value.trim(),
          url: newUrl.value.trim(),
          events: newEvents.value,
        },
      },
    )
    webhooks.value.unshift({ ...result, secret: `****${result.secret.slice(-4)}` })
    createdSecret.value = result.secret
    newName.value = ''
    newUrl.value = ''
    newEvents.value = []
    createOpen.value = false
    toast.success(t('webhooks.created'))
  }
  catch {
    toast.error(t('webhooks.create_error'))
  }
  finally {
    creating.value = false
  }
}

async function testWebhook(webhookId: string) {
  testing.value = webhookId
  try {
    const result = await $fetch<{ success: boolean, statusCode: number | null }>(
      `/api/workspaces/${props.workspaceId}/projects/${props.projectId}/webhooks/${webhookId}/test`,
      { method: 'POST' },
    )
    if (result.success) {
      toast.success(t('webhooks.test_success'))
    }
    else {
      toast.error(`${t('webhooks.test_failed')} (${result.statusCode ?? 'timeout'})`)
    }
  }
  catch {
    toast.error(t('webhooks.test_failed'))
  }
  finally {
    testing.value = null
  }
}

async function deleteWebhook(webhookId: string) {
  deleting.value = webhookId
  try {
    await $fetch(
      `/api/workspaces/${props.workspaceId}/projects/${props.projectId}/webhooks/${webhookId}`,
      { method: 'DELETE' },
    )
    webhooks.value = webhooks.value.filter(w => w.id !== webhookId)
    toast.success(t('webhooks.deleted'))
  }
  catch {
    toast.error(t('webhooks.delete_error'))
  }
  finally {
    deleting.value = null
    confirmDeleteId.value = null
  }
}

function copySecret() {
  if (!createdSecret.value) return
  navigator.clipboard.writeText(createdSecret.value)
  copied.value = true
  toast.success(t('common.copied'))
  setTimeout(() => {
    copied.value = false
  }, 2000)
}

function dismissSecret() {
  createdSecret.value = null
  copied.value = false
}

function toggleEvent(event: string) {
  const idx = newEvents.value.indexOf(event)
  if (idx >= 0) {
    newEvents.value.splice(idx, 1)
  }
  else {
    newEvents.value.push(event)
  }
}

function truncateUrl(url: string, max = 40): string {
  if (url.length <= max) return url
  return `${url.substring(0, max)}...`
}

// Reset create form when dialog opens
watch(createOpen, (isOpen) => {
  if (isOpen) {
    newName.value = ''
    newUrl.value = ''
    newEvents.value = []
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
        icon="icon-[annon--bell]"
        :title="t('webhooks.title')"
        :description="t('webhooks.description')"
      >
        <template #action>
          <AtomsBadge variant="info" size="md">
            Business
          </AtomsBadge>
        </template>
      </AtomsEmptyState>
    </div>

    <!-- Webhooks Management -->
    <div v-else class="flex-1 overflow-y-auto">
      <!-- Header -->
      <div class="flex items-center justify-between border-b border-secondary-200 px-5 py-3 dark:border-secondary-800">
        <div>
          <div class="text-sm font-medium text-heading dark:text-secondary-100">
            {{ t('webhooks.title') }}
          </div>
          <p class="text-xs text-muted">
            {{ t('webhooks.description') }}
          </p>
        </div>
        <AtomsBaseButton v-if="canManage" variant="primary" size="sm" @click="createOpen = true">
          <template #prepend>
            <span class="icon-[annon--plus] size-3.5" aria-hidden="true" />
          </template>
          {{ t('webhooks.create') }}
        </AtomsBaseButton>
      </div>

      <!-- Newly created secret alert -->
      <div v-if="createdSecret" class="mx-5 mt-4 rounded-lg border border-warning-200 bg-warning-50 p-3 dark:border-warning-500/20 dark:bg-warning-500/10">
        <div class="flex items-start justify-between gap-2">
          <div class="flex items-center gap-2">
            <span class="icon-[annon--alert-triangle] size-4 shrink-0 text-warning-500" aria-hidden="true" />
            <p class="text-xs font-medium text-warning-700 dark:text-warning-400">
              {{ t('webhooks.copy_warning') }}
            </p>
          </div>
          <button
            type="button"
            class="shrink-0 rounded-md p-0.5 text-muted transition-colors hover:text-heading focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50 dark:hover:text-secondary-100"
            @click="dismissSecret"
          >
            <span class="icon-[annon--cross] block size-3" aria-hidden="true" />
          </button>
        </div>
        <div class="mt-1 text-[10px] text-muted">
          {{ t('webhooks.secret') }}
        </div>
        <div class="mt-1 flex items-center gap-2">
          <code class="flex-1 truncate rounded bg-white px-2 py-1 font-mono text-[11px] text-heading dark:bg-secondary-900 dark:text-secondary-100">
            {{ createdSecret }}
          </code>
          <AtomsBaseButton variant="ghost" size="sm" @click="copySecret">
            <span
              :class="copied ? 'icon-[annon--check]' : 'icon-[annon--copy]'"
              class="size-3.5"
              aria-hidden="true"
            />
          </AtomsBaseButton>
        </div>
      </div>

      <!-- Webhooks list -->
      <div class="px-5 pt-4 pb-5">
        <div class="mb-2 flex items-center gap-1">
          <AtomsSectionLabel :label="t('webhooks.title')" :count="webhooks.length" />
        </div>

        <div v-if="webhooks.length > 0" class="space-y-1.5">
          <div
            v-for="webhook in webhooks"
            :key="webhook.id"
            class="rounded-lg border border-secondary-200 px-3 py-2.5 dark:border-secondary-800"
          >
            <!-- Top row: name + status -->
            <div class="flex items-center gap-2">
              <span class="icon-[annon--bell] size-3.5 shrink-0 text-muted" aria-hidden="true" />
              <div class="min-w-0 flex-1">
                <div class="flex items-center gap-2">
                  <span class="truncate text-xs font-medium text-heading dark:text-secondary-100">
                    {{ webhook.name }}
                  </span>
                  <AtomsBadge
                    :variant="webhook.active ? 'success' : 'secondary'"
                    size="sm"
                  >
                    {{ webhook.active ? t('webhooks.active') : t('webhooks.inactive') }}
                  </AtomsBadge>
                </div>
                <div class="mt-0.5 font-mono text-[10px] text-muted">
                  {{ truncateUrl(webhook.url) }}
                </div>
              </div>

              <!-- Actions -->
              <div v-if="canManage" class="flex shrink-0 items-center gap-1">
                <!-- Test button -->
                <button
                  type="button"
                  :disabled="testing === webhook.id"
                  class="rounded px-1.5 py-0.5 text-[10px] font-medium text-primary-500 transition-colors hover:bg-primary-50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary-500/50 disabled:opacity-50 dark:hover:bg-primary-900/20"
                  @click="testWebhook(webhook.id)"
                >
                  <span v-if="testing === webhook.id" class="inline-block size-2.5 animate-spin rounded-full border border-primary-300 border-t-primary-600" />
                  <template v-else>
                    {{ t('webhooks.test') }}
                  </template>
                </button>

                <!-- Delete -->
                <button
                  v-if="confirmDeleteId !== webhook.id"
                  type="button"
                  class="rounded px-1.5 py-0.5 text-[10px] font-medium text-danger-500 transition-colors hover:bg-danger-50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-danger-500/50 dark:hover:bg-danger-900/20"
                  @click="confirmDeleteId = webhook.id"
                >
                  {{ t('common.delete') }}
                </button>
                <div v-else class="flex items-center gap-1">
                  <AtomsBaseButton
                    variant="danger"
                    size="sm"
                    :disabled="deleting === webhook.id"
                    @click="deleteWebhook(webhook.id)"
                  >
                    <template v-if="deleting === webhook.id" #prepend>
                      <div class="size-3 animate-spin rounded-full border-2 border-white/30 border-t-white" />
                    </template>
                    {{ t('common.delete') }}
                  </AtomsBaseButton>
                  <AtomsBaseButton variant="ghost" size="sm" @click="confirmDeleteId = null">
                    {{ t('common.cancel') }}
                  </AtomsBaseButton>
                </div>
              </div>
            </div>

            <!-- Event badges -->
            <div class="mt-2 flex flex-wrap gap-1">
              <span
                v-for="event in webhook.events"
                :key="event"
                class="inline-flex items-center rounded-full bg-secondary-100 px-1.5 py-0.5 text-[10px] font-medium text-body dark:bg-secondary-800 dark:text-secondary-300"
              >
                {{ event }}
              </span>
            </div>
          </div>
        </div>

        <!-- Empty state -->
        <div v-else class="py-8">
          <AtomsEmptyState
            icon="icon-[annon--bell]"
            :title="t('webhooks.no_webhooks')"
            :description="t('webhooks.no_webhooks_description')"
            compact
          >
            <template v-if="canManage" #action>
              <AtomsBaseButton variant="primary" size="sm" @click="createOpen = true">
                <template #prepend>
                  <span class="icon-[annon--plus] size-3.5" aria-hidden="true" />
                </template>
                {{ t('webhooks.create') }}
              </AtomsBaseButton>
            </template>
          </AtomsEmptyState>
        </div>
      </div>
    </div>

    <!-- Create Webhook Dialog -->
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
              {{ t('webhooks.create') }}
            </DialogTitle>
            <DialogClose
              class="rounded-md p-1 text-muted transition-colors hover:bg-secondary-100 hover:text-heading focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50 dark:hover:bg-secondary-800 dark:hover:text-secondary-100"
            >
              <span class="icon-[annon--cross] block size-4" aria-hidden="true" />
            </DialogClose>
          </div>
          <DialogDescription class="sr-only">
            {{ t('webhooks.create') }}
          </DialogDescription>

          <!-- Dialog Body -->
          <form class="space-y-4 px-5 py-4" @submit.prevent="createWebhook">
            <!-- Name -->
            <div>
              <AtomsFormLabel for="webhook-name" :text="t('webhooks.name')" size="sm" required />
              <AtomsFormInput
                id="webhook-name"
                v-model="newName"
                type="text"
                :placeholder="t('webhooks.name_placeholder')"
                class="mt-1.5"
                required
              />
            </div>

            <!-- URL -->
            <div>
              <AtomsFormLabel for="webhook-url" :text="t('webhooks.url')" size="sm" required />
              <AtomsFormInput
                id="webhook-url"
                v-model="newUrl"
                type="url"
                :placeholder="t('webhooks.url_placeholder')"
                class="mt-1.5"
                required
              />
            </div>

            <!-- Events -->
            <div>
              <AtomsFormLabel :text="t('webhooks.events')" size="sm" required />
              <div class="mt-1.5 grid grid-cols-2 gap-1.5">
                <button
                  v-for="event in AVAILABLE_EVENTS"
                  :key="event"
                  type="button"
                  class="flex items-center gap-2 rounded-lg border px-2.5 py-2 text-left text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50"
                  :class="newEvents.includes(event)
                    ? 'border-primary-500 bg-primary-50 text-primary-700 dark:border-primary-400 dark:bg-primary-900/20 dark:text-primary-300'
                    : 'border-secondary-200 text-body hover:border-secondary-300 dark:border-secondary-700 dark:text-secondary-400 dark:hover:border-secondary-600'
                  "
                  @click="toggleEvent(event)"
                >
                  <span
                    class="size-3.5 shrink-0 rounded border transition-colors"
                    :class="newEvents.includes(event)
                      ? 'border-primary-500 bg-primary-500 dark:border-primary-400 dark:bg-primary-400'
                      : 'border-secondary-300 dark:border-secondary-600'
                    "
                  >
                    <span
                      v-if="newEvents.includes(event)"
                      class="icon-[annon--check] block size-3.5 text-white"
                      aria-hidden="true"
                    />
                  </span>
                  <span class="truncate">{{ event }}</span>
                </button>
              </div>
            </div>

            <!-- Footer -->
            <div class="flex items-center justify-end gap-2 border-t border-secondary-200 pt-4 dark:border-secondary-800">
              <DialogClose as-child>
                <AtomsBaseButton variant="ghost" size="sm">
                  {{ t('common.cancel') }}
                </AtomsBaseButton>
              </DialogClose>
              <AtomsBaseButton
                type="submit"
                variant="primary"
                size="sm"
                :disabled="!newName.trim() || !newUrl.trim() || newEvents.length === 0 || creating"
              >
                <template v-if="creating" #prepend>
                  <div class="size-3.5 animate-spin rounded-full border-2 border-white/30 border-t-white" />
                </template>
                {{ creating ? t('webhooks.creating') : t('webhooks.create') }}
              </AtomsBaseButton>
            </div>
          </form>
        </DialogContent>
      </DialogPortal>
    </DialogRoot>
  </div>
</template>

<script setup lang="ts">
import { ComboboxAnchor, ComboboxContent, ComboboxEmpty, ComboboxInput, ComboboxItem, ComboboxItemIndicator, ComboboxPortal, ComboboxRoot, ComboboxViewport, DialogClose, DialogContent, DialogDescription, DialogOverlay, DialogPortal, DialogRoot, DialogTitle } from 'radix-vue'
import { ISO_LOCALES, getLocaleName } from '~/utils/locales'

const { t } = useContent()
const toast = useToast()
const { activeWorkspace } = useWorkspaces()
const canReview = computed(() => hasFeature(activeWorkspace.value?.plan, 'workflow.review'))
const canCDN = computed(() => hasFeature(activeWorkspace.value?.plan, 'cdn.delivery'))

const open = defineModel<boolean>('open', { default: false })

const props = defineProps<{
  workspaceId: string
  projectId: string
  config: {
    workflow?: string
    stack?: string
    domains?: string[]
    locales?: { default?: string, supported?: string[] }
  } | null
  cdnEnabled?: boolean
}>()

const emit = defineEmits<{
  saved: []
}>()

// Local form state — initialized from config
const workflow = ref('auto-merge')
const domains = ref<string[]>([])
const defaultLocale = ref('en')
const supportedLocales = ref<string[]>(['en'])
const newDomain = ref('')
const saving = ref(false)

// CDN state
interface CDNKey { id: string, name: string, key_prefix: string, environment: string, created_at: string, revoked_at: string | null, key?: string }
interface CDNBuild { id: string, status: string, trigger_type: string, commit_sha: string, file_count: number | null, build_duration_ms: number | null, error_message: string | null, started_at: string }
const cdnActive = ref(false)
const cdnKeys = ref<CDNKey[]>([])
const cdnBuilds = ref<CDNBuild[]>([])
const cdnKeyName = ref('')
const cdnCreatingKey = ref(false)
const cdnRebuilding = ref(false)
const cdnNewKey = ref<string | null>(null)
const cdnCopied = ref(false)

// Available locales = ISO list minus already selected
const availableLocales = computed(() =>
  ISO_LOCALES.filter(l => !supportedLocales.value.includes(l.code)),
)

// Custom filter: match by code OR name
function filterLocales(options: readonly string[], term: string): string[] {
  if (!term) return [...options]
  const q = term.toLowerCase()
  return options.filter((code) => {
    const locale = ISO_LOCALES.find(l => l.code === code)
    return code.toLowerCase().includes(q) || (locale?.name.toLowerCase().includes(q) ?? false)
  })
}

// Sync from props when modal opens
watch(open, async (isOpen) => {
  if (isOpen && props.config) {
    workflow.value = props.config.workflow ?? 'auto-merge'
    domains.value = [...(props.config.domains ?? [])]
    defaultLocale.value = props.config.locales?.default ?? 'en'
    supportedLocales.value = [...(props.config.locales?.supported ?? ['en'])]

    // Load CDN data
    cdnActive.value = props.cdnEnabled ?? false
    if (canCDN.value) {
      try {
        cdnKeys.value = await $fetch<CDNKey[]>(`/api/workspaces/${props.workspaceId}/projects/${props.projectId}/cdn/keys`)
      }
      catch { cdnKeys.value = [] }

      try {
        cdnBuilds.value = await $fetch<CDNBuild[]>(`/api/workspaces/${props.workspaceId}/projects/${props.projectId}/cdn/builds`)
      }
      catch { cdnBuilds.value = [] }
    }

    cdnNewKey.value = null
    cdnCopied.value = false
  }
})

const hasChanges = computed(() => {
  if (!props.config) return false
  return workflow.value !== (props.config.workflow ?? 'auto-merge')
    || JSON.stringify(domains.value) !== JSON.stringify(props.config.domains ?? [])
    || defaultLocale.value !== (props.config.locales?.default ?? 'en')
    || JSON.stringify(supportedLocales.value) !== JSON.stringify(props.config.locales?.supported ?? ['en'])
})

function addDomain() {
  const d = newDomain.value.trim().toLowerCase()
  if (d && !domains.value.includes(d)) {
    domains.value.push(d)
  }
  newDomain.value = ''
}

function removeDomain(domain: string) {
  domains.value = domains.value.filter(d => d !== domain)
}

function addLocale(code: string) {
  if (code && !supportedLocales.value.includes(code)) {
    supportedLocales.value.push(code)
  }
}

function removeLocale(locale: string) {
  if (supportedLocales.value.length <= 1) return
  supportedLocales.value = supportedLocales.value.filter(l => l !== locale)
  if (defaultLocale.value === locale) {
    defaultLocale.value = supportedLocales.value[0] ?? 'en'
  }
}

async function toggleCDN() {
  const newValue = !cdnActive.value
  try {
    await $fetch(`/api/workspaces/${props.workspaceId}/projects/${props.projectId}/cdn/settings`, {
      method: 'PATCH',
      body: { cdn_enabled: newValue },
    })
    cdnActive.value = newValue
  }
  catch {
    toast.error(t('project_settings.save_error'))
  }
}

async function createCDNKey() {
  if (!cdnKeyName.value.trim()) return
  cdnCreatingKey.value = true
  try {
    const result = await $fetch<CDNKey>(`/api/workspaces/${props.workspaceId}/projects/${props.projectId}/cdn/keys`, {
      method: 'POST',
      body: { name: cdnKeyName.value.trim() },
    })
    cdnKeys.value.unshift(result)
    cdnNewKey.value = result.key ?? null
    cdnKeyName.value = ''
    toast.success(t('cdn.key_created'))
  }
  catch {
    toast.error(t('project_settings.save_error'))
  }
  finally {
    cdnCreatingKey.value = false
  }
}

async function revokeCDNKey(keyId: string) {
  try {
    await $fetch(`/api/workspaces/${props.workspaceId}/projects/${props.projectId}/cdn/keys/${keyId}`, {
      method: 'DELETE',
    })
    cdnKeys.value = cdnKeys.value.map(k => k.id === keyId ? { ...k, revoked_at: new Date().toISOString() } : k)
    toast.success(t('cdn.key_revoked'))
  }
  catch {
    toast.error(t('project_settings.save_error'))
  }
}

async function triggerRebuild() {
  cdnRebuilding.value = true
  try {
    await $fetch(`/api/workspaces/${props.workspaceId}/projects/${props.projectId}/cdn/builds/trigger`, {
      method: 'POST',
    })
    toast.success(t('cdn.rebuild_triggered'))
    // Refresh builds
    cdnBuilds.value = await $fetch<CDNBuild[]>(`/api/workspaces/${props.workspaceId}/projects/${props.projectId}/cdn/builds`)
  }
  catch {
    toast.error(t('project_settings.save_error'))
  }
  finally {
    cdnRebuilding.value = false
  }
}

function copyCDNKey() {
  if (!cdnNewKey.value) return
  navigator.clipboard.writeText(cdnNewKey.value)
  cdnCopied.value = true
  setTimeout(() => {
    cdnCopied.value = false
  }, 2000)
}

const activeKeys = computed(() => cdnKeys.value.filter(k => !k.revoked_at))

const buildStatusVariant: Record<string, 'success' | 'danger' | 'warning' | 'secondary'> = {
  success: 'success',
  failed: 'danger',
  building: 'warning',
  pending: 'secondary',
}

async function save() {
  saving.value = true
  try {
    await $fetch(`/api/workspaces/${props.workspaceId}/projects/${props.projectId}/config`, {
      method: 'PATCH',
      body: {
        workflow: workflow.value,
        domains: domains.value,
        locales: {
          default: defaultLocale.value,
          supported: supportedLocales.value,
        },
      },
    })
    toast.success(t('project_settings.save_success'))
    open.value = false
    emit('saved')
  }
  catch {
    toast.error(t('project_settings.save_error'))
  }
  finally {
    saving.value = false
  }
}
</script>

<template>
  <DialogRoot v-model:open="open">
    <DialogPortal>
      <DialogOverlay class="fixed inset-0 z-50 bg-black/50 data-[state=open]:animate-in data-[state=open]:fade-in data-[state=closed]:animate-out data-[state=closed]:fade-out" />
      <DialogContent
        class="fixed left-1/2 top-1/2 z-50 w-full max-w-lg -translate-x-1/2 -translate-y-1/2 rounded-xl border border-secondary-200 bg-white shadow-xl dark:border-secondary-800 dark:bg-secondary-950"
        @interact-outside.prevent
      >
        <!-- Header -->
        <div class="flex items-center justify-between border-b border-secondary-200 px-5 py-4 dark:border-secondary-800">
          <div>
            <DialogTitle class="text-base font-semibold text-heading dark:text-secondary-100">
              {{ t('project_settings.title') }}
            </DialogTitle>
            <DialogDescription class="sr-only">
              {{ t('project_settings.title') }}
            </DialogDescription>
          </div>
          <DialogClose
            class="rounded-md p-1 text-muted transition-colors hover:bg-secondary-100 hover:text-heading focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50 dark:hover:bg-secondary-800 dark:hover:text-secondary-100"
          >
            <span class="icon-[annon--cross] block size-4" aria-hidden="true" />
          </DialogClose>
        </div>

        <!-- Body -->
        <div class="max-h-[60vh] space-y-5 overflow-y-auto px-5 py-4">
          <!-- Workflow -->
          <div>
            <AtomsFormLabel :text="t('project_settings.workflow')" size="sm" />
            <div class="mt-2 flex gap-2">
              <button
                type="button"
                class="flex-1 rounded-lg border px-3 py-2.5 text-left text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50"
                :class="workflow === 'auto-merge'
                  ? 'border-primary-500 bg-primary-50 text-primary-700 dark:border-primary-400 dark:bg-primary-900/20 dark:text-primary-300'
                  : 'border-secondary-200 text-body hover:border-secondary-300 dark:border-secondary-700 dark:text-secondary-400 dark:hover:border-secondary-600'
                "
                @click="workflow = 'auto-merge'"
              >
                <div class="font-medium">
                  {{ t('project_settings.workflow_auto') }}
                </div>
                <div class="mt-0.5 text-xs opacity-70">
                  {{ t('project_settings.workflow_auto_desc') }}
                </div>
              </button>
              <button
                type="button"
                :disabled="!canReview"
                class="flex-1 rounded-lg border px-3 py-2.5 text-left text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50 disabled:cursor-not-allowed disabled:opacity-50"
                :class="workflow === 'review'
                  ? 'border-primary-500 bg-primary-50 text-primary-700 dark:border-primary-400 dark:bg-primary-900/20 dark:text-primary-300'
                  : 'border-secondary-200 text-body hover:border-secondary-300 dark:border-secondary-700 dark:text-secondary-400 dark:hover:border-secondary-600'
                "
                @click="canReview ? workflow = 'review' : undefined"
              >
                <div class="flex items-center gap-1.5 font-medium">
                  {{ t('project_settings.workflow_review') }}
                  <AtomsBadge v-if="!canReview" variant="info" size="sm">
                    Pro
                  </AtomsBadge>
                </div>
                <div class="mt-0.5 text-xs opacity-70">
                  {{ t('project_settings.workflow_review_desc') }}
                </div>
              </button>
            </div>
          </div>

          <!-- Stack (read-only) -->
          <div>
            <AtomsFormLabel :text="t('project_settings.stack')" size="sm" />
            <div class="mt-1.5">
              <AtomsBadge variant="secondary" size="md">
                {{ config?.stack ?? 'other' }}
              </AtomsBadge>
            </div>
          </div>

          <!-- Default Locale -->
          <div>
            <AtomsFormLabel :text="t('project_settings.default_locale')" size="sm" />
            <AtomsFormSelect
              :model-value="defaultLocale"
              :options="supportedLocales.map(l => ({ value: l, label: `${l.toUpperCase()} — ${getLocaleName(l)}` }))"
              size="md"
              class="mt-1.5"
              @update:model-value="defaultLocale = $event"
            />
          </div>

          <!-- Supported Locales -->
          <div>
            <AtomsFormLabel :text="t('project_settings.locales')" size="sm" />
            <div class="mt-1.5 flex flex-wrap gap-1.5">
              <span
                v-for="locale in supportedLocales"
                :key="locale"
                class="inline-flex items-center gap-1 rounded-md bg-secondary-100 px-2 py-1 text-xs font-medium text-heading dark:bg-secondary-800 dark:text-secondary-100"
              >
                {{ locale.toUpperCase() }}
                <span class="text-[10px] font-normal text-muted">{{ getLocaleName(locale) }}</span>
                <button
                  v-if="supportedLocales.length > 1"
                  type="button"
                  class="ml-0.5 rounded text-muted transition-colors hover:text-danger-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50"
                  @click="removeLocale(locale)"
                >
                  <span class="icon-[annon--cross] block size-3" aria-hidden="true" />
                </button>
              </span>
            </div>
            <!-- Searchable locale picker -->
            <ComboboxRoot
              class="relative mt-2"
              :model-value="''"
              :filter-function="filterLocales"
              @update:model-value="addLocale($event as string)"
            >
              <ComboboxAnchor class="flex items-center gap-1.5 rounded-lg border border-secondary-200 bg-white px-2.5 dark:border-secondary-700 dark:bg-secondary-900">
                <span class="icon-[annon--search] size-3.5 shrink-0 text-muted" aria-hidden="true" />
                <ComboboxInput
                  :placeholder="t('project_settings.locale_placeholder')"
                  class="h-8 flex-1 bg-transparent text-sm text-heading placeholder:text-disabled focus:outline-none dark:text-secondary-100"
                />
              </ComboboxAnchor>
              <ComboboxPortal>
                <ComboboxContent
                  position="popper"
                  :side-offset="4"
                  class="z-[100] max-h-48 w-[var(--radix-combobox-trigger-width)] overflow-hidden rounded-lg border border-secondary-200 bg-white shadow-lg dark:border-secondary-800 dark:bg-secondary-950"
                >
                  <ComboboxViewport class="p-1">
                    <ComboboxEmpty class="px-3 py-2 text-xs text-muted">
                      No matching language
                    </ComboboxEmpty>
                    <ComboboxItem
                      v-for="locale in availableLocales"
                      :key="locale.code"
                      :value="locale.code"
                      class="flex items-center gap-2 rounded-md px-2.5 py-1.5 text-sm text-heading outline-none transition-colors data-highlighted:bg-secondary-50 dark:text-secondary-100 dark:data-highlighted:bg-secondary-900"
                    >
                      <span class="w-7 shrink-0 text-xs font-medium text-muted">{{ locale.code.toUpperCase() }}</span>
                      <span>{{ locale.name }}</span>
                      <ComboboxItemIndicator class="ml-auto">
                        <span class="icon-[annon--check] size-3.5 text-primary-500" aria-hidden="true" />
                      </ComboboxItemIndicator>
                    </ComboboxItem>
                  </ComboboxViewport>
                </ComboboxContent>
              </ComboboxPortal>
            </ComboboxRoot>
          </div>

          <!-- Domains -->
          <div>
            <AtomsFormLabel :text="t('project_settings.domains')" size="sm" />
            <div class="mt-1.5 flex flex-wrap gap-1.5">
              <span
                v-for="domain in domains"
                :key="domain"
                class="inline-flex items-center gap-1 rounded-md bg-secondary-100 px-2 py-1 text-xs font-medium text-heading dark:bg-secondary-800 dark:text-secondary-100"
              >
                {{ domain }}
                <button
                  type="button"
                  class="ml-0.5 rounded text-muted transition-colors hover:text-danger-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50"
                  @click="removeDomain(domain)"
                >
                  <span class="icon-[annon--cross] block size-3" aria-hidden="true" />
                </button>
              </span>
            </div>
            <form class="mt-2 flex items-center gap-2" @submit.prevent="addDomain">
              <AtomsFormInput
                v-model="newDomain"
                type="text"
                :placeholder="t('project_settings.domains_placeholder')"
                class="w-40"
              />
              <AtomsBaseButton type="submit" variant="ghost" size="sm" :disabled="!newDomain.trim()">
                <span class="icon-[annon--plus] size-3.5" aria-hidden="true" />
              </AtomsBaseButton>
            </form>
          </div>

          <!-- CDN Section -->
          <div class="border-t border-secondary-200 pt-5 dark:border-secondary-800">
            <div class="flex items-center justify-between">
              <div>
                <AtomsFormLabel :text="t('cdn.title')" size="sm" />
                <p class="mt-0.5 text-xs text-muted">
                  {{ t('cdn.description') }}
                </p>
              </div>
              <template v-if="canCDN">
                <button
                  type="button"
                  class="relative inline-flex h-6 w-11 shrink-0 rounded-full border-2 border-transparent transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50"
                  :class="cdnActive ? 'bg-primary-500' : 'bg-secondary-200 dark:bg-secondary-700'"
                  @click="toggleCDN"
                >
                  <span
                    class="pointer-events-none inline-block size-5 rounded-full bg-white shadow-sm transition-transform"
                    :class="cdnActive ? 'translate-x-5' : 'translate-x-0'"
                  />
                </button>
              </template>
              <AtomsBadge v-else variant="info" size="sm">
                Pro
              </AtomsBadge>
            </div>

            <!-- CDN enabled content -->
            <template v-if="canCDN && cdnActive">
              <!-- New key alert -->
              <div v-if="cdnNewKey" class="mt-3 rounded-lg border border-success-200 bg-success-50 p-3 dark:border-success-500/20 dark:bg-success-500/10">
                <p class="text-xs font-medium text-success-700 dark:text-success-400">
                  {{ t('cdn.key_created') }}
                </p>
                <div class="mt-2 flex items-center gap-2">
                  <code class="flex-1 truncate rounded bg-white px-2 py-1 font-mono text-xs text-heading dark:bg-secondary-900 dark:text-secondary-100">{{ cdnNewKey }}</code>
                  <AtomsBaseButton variant="ghost" size="sm" @click="copyCDNKey">
                    <span :class="cdnCopied ? 'icon-[annon--check]' : 'icon-[annon--copy]'" class="size-3.5" aria-hidden="true" />
                    {{ cdnCopied ? t('cdn.copied') : t('cdn.copy') }}
                  </AtomsBaseButton>
                </div>
              </div>

              <!-- API Keys -->
              <div class="mt-4">
                <div class="flex items-center justify-between">
                  <span class="text-xs font-semibold uppercase tracking-wider text-muted">{{ t('cdn.keys_title') }}</span>
                  <AtomsBadge variant="secondary" size="sm">
                    {{ activeKeys.length }}
                  </AtomsBadge>
                </div>

                <ul v-if="activeKeys.length > 0" class="mt-2 divide-y divide-secondary-100 rounded-lg border border-secondary-200 dark:divide-secondary-800 dark:border-secondary-800">
                  <li v-for="key in activeKeys" :key="key.id" class="flex items-center gap-2 px-3 py-2">
                    <span class="icon-[annon--key] size-3.5 shrink-0 text-muted" aria-hidden="true" />
                    <div class="min-w-0 flex-1">
                      <div class="truncate text-xs font-medium text-heading dark:text-secondary-100">
                        {{ key.name }}
                      </div>
                      <div class="text-[10px] text-muted">
                        {{ key.key_prefix }}...
                      </div>
                    </div>
                    <button
                      type="button"
                      class="shrink-0 rounded px-1.5 py-0.5 text-[10px] text-danger-500 transition-colors hover:bg-danger-50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-danger-500/50 dark:hover:bg-danger-900/20"
                      @click="revokeCDNKey(key.id)"
                    >
                      {{ t('cdn.revoke') }}
                    </button>
                  </li>
                </ul>
                <p v-else class="mt-2 text-xs text-muted">
                  {{ t('cdn.no_keys') }}
                </p>

                <!-- Create key form -->
                <form class="mt-2 flex items-center gap-2" @submit.prevent="createCDNKey">
                  <AtomsFormInput
                    v-model="cdnKeyName"
                    type="text"
                    :placeholder="t('cdn.key_name_placeholder')"
                    class="flex-1"
                  />
                  <AtomsBaseButton type="submit" variant="primary" size="sm" :disabled="!cdnKeyName.trim() || cdnCreatingKey">
                    {{ t('cdn.create_key') }}
                  </AtomsBaseButton>
                </form>
              </div>

              <!-- Build History -->
              <div class="mt-4">
                <div class="flex items-center justify-between">
                  <span class="text-xs font-semibold uppercase tracking-wider text-muted">{{ t('cdn.builds_title') }}</span>
                  <AtomsBaseButton variant="ghost" size="sm" :disabled="cdnRebuilding" @click="triggerRebuild">
                    <span class="icon-[annon--refresh] size-3.5" :class="cdnRebuilding ? 'animate-spin' : ''" aria-hidden="true" />
                    {{ cdnRebuilding ? t('cdn.rebuilding') : t('cdn.rebuild') }}
                  </AtomsBaseButton>
                </div>

                <ul v-if="cdnBuilds.length > 0" class="mt-2 space-y-1">
                  <li v-for="build in cdnBuilds.slice(0, 5)" :key="build.id" class="flex items-center gap-2 rounded-md px-2 py-1.5 text-xs">
                    <AtomsBadge :variant="buildStatusVariant[build.status] ?? 'secondary'" size="sm">
                      {{ t(`cdn.build_${build.status}`) }}
                    </AtomsBadge>
                    <span class="flex-1 truncate text-muted">
                      {{ build.commit_sha.substring(0, 7) }}
                      <span v-if="build.file_count"> · {{ build.file_count }} {{ t('cdn.files') }}</span>
                      <span v-if="build.build_duration_ms"> · {{ build.build_duration_ms }}ms</span>
                    </span>
                    <span class="shrink-0 text-[10px] text-disabled">{{ build.trigger_type }}</span>
                  </li>
                </ul>
                <p v-else class="mt-2 text-xs text-muted">
                  {{ t('cdn.no_builds') }}
                </p>
              </div>

              <!-- SDK Snippet -->
              <details class="mt-4 group">
                <summary class="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-muted transition-colors hover:text-heading">
                  <span class="icon-[annon--code] size-3.5" aria-hidden="true" />
                  {{ t('cdn.snippet_title') }}
                  <span class="icon-[annon--chevron-right] ml-auto size-3 transition-transform group-open:rotate-90" aria-hidden="true" />
                </summary>
                <pre class="mt-2 overflow-x-auto rounded-lg bg-secondary-50 p-3 text-[11px] text-heading dark:bg-secondary-900 dark:text-secondary-100"><code>import { createContentrain } from '@contentrain/sdk'

const client = createContentrain({
  projectId: '{{ projectId }}',
  apiKey: 'crn_live_xxxxx',
})

const posts = await client
  .collection('blog-posts')
  .locale('en')
  .get()</code></pre>
              </details>
            </template>
          </div>
        </div>

        <!-- Footer -->
        <div class="flex items-center justify-end gap-2 border-t border-secondary-200 px-5 py-3 dark:border-secondary-800">
          <AtomsBaseButton variant="ghost" size="md" @click="open = false">
            {{ t('common.cancel') }}
          </AtomsBaseButton>
          <AtomsBaseButton
            variant="primary"
            size="md"
            :disabled="!hasChanges || saving"
            @click="save"
          >
            {{ saving ? t('project_settings.saving') : t('common.save_changes') }}
          </AtomsBaseButton>
        </div>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>

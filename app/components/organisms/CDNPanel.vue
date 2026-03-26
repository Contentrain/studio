<script setup lang="ts">
const { t } = useContent()
const toast = useToast()
const { activeWorkspace } = useWorkspaces()
const { isOwnerOrAdmin } = useWorkspaceRole()

const props = defineProps<{
  workspaceId: string
  projectId: string
}>()

const isPro = computed(() => hasFeature(activeWorkspace.value?.plan, 'cdn.delivery'))
const canManageCDN = computed(() => isPro.value && isOwnerOrAdmin.value)

interface CDNKey { id: string, name: string, key_prefix: string, environment: string, created_at: string, revoked_at: string | null, key?: string }
interface CDNBuild { id: string, status: string, trigger_type: string, commit_sha: string, file_count: number | null, build_duration_ms: number | null, error_message: string | null, started_at: string }

const cdnActive = ref(false)
const keys = ref<CDNKey[]>([])
const builds = ref<CDNBuild[]>([])
const keyName = ref('')
const creatingKey = ref(false)
const rebuilding = ref(false)
const newKey = ref<string | null>(null)
const copied = ref(false)
const loading = ref(true)

const activeKeys = computed(() => keys.value.filter(k => !k.revoked_at))

// Build progress state
const buildProgress = ref<{ phase: string, message: string, current?: number, total?: number } | null>(null)

const buildStatusVariant: Record<string, 'success' | 'danger' | 'warning' | 'secondary'> = {
  success: 'success',
  failed: 'danger',
  building: 'warning',
  pending: 'secondary',
}

async function loadCDNData() {
  if (!props.workspaceId || !props.projectId) return
  loading.value = true
  if (!isPro.value) {
    loading.value = false
    return
  }
  try {
    const requests = [
      $fetch<{ cdn_enabled: boolean, cdn_branch: string | null }>(
        `/api/workspaces/${props.workspaceId}/projects/${props.projectId}/cdn/settings`,
      ),
      $fetch<CDNBuild[]>(
        `/api/workspaces/${props.workspaceId}/projects/${props.projectId}/cdn/builds`,
      ),
    ] as const

    if (canManageCDN.value) {
      const [settingsRes, buildsRes, keysRes] = await Promise.all([
        ...requests,
        $fetch<CDNKey[]>(
          `/api/workspaces/${props.workspaceId}/projects/${props.projectId}/cdn/keys`,
        ),
      ])
      cdnActive.value = settingsRes.cdn_enabled ?? false
      keys.value = keysRes
      builds.value = buildsRes
      return
    }

    const [settingsRes, buildsRes] = await Promise.all(requests)
    cdnActive.value = settingsRes.cdn_enabled ?? false
    keys.value = []
    builds.value = buildsRes
  }
  catch (e) {
    // eslint-disable-next-line no-console
    console.error('[CDNPanel] Load error:', e)
  }
  finally {
    loading.value = false
  }
}

// Load when both IDs are available — handles page refresh timing
// (activeWorkspace is null at first render, then populated by onMounted)
watch(
  [() => props.workspaceId, () => props.projectId],
  ([ws, proj]) => {
    if (ws && proj) loadCDNData()
  },
  { immediate: true },
)

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

async function createKey() {
  if (!keyName.value.trim()) return
  creatingKey.value = true
  try {
    const result = await $fetch<CDNKey>(`/api/workspaces/${props.workspaceId}/projects/${props.projectId}/cdn/keys`, {
      method: 'POST',
      body: { name: keyName.value.trim() },
    })
    keys.value.unshift(result)
    newKey.value = result.key ?? null
    keyName.value = ''
    toast.success(t('cdn.key_created'))
  }
  catch {
    toast.error(t('project_settings.save_error'))
  }
  finally {
    creatingKey.value = false
  }
}

async function revokeKey(keyId: string) {
  try {
    await $fetch(`/api/workspaces/${props.workspaceId}/projects/${props.projectId}/cdn/keys/${keyId}`, { method: 'DELETE' })
    keys.value = keys.value.map(k => k.id === keyId ? { ...k, revoked_at: new Date().toISOString() } : k)
    toast.success(t('cdn.key_revoked'))
  }
  catch {
    toast.error(t('project_settings.save_error'))
  }
}

async function triggerRebuild() {
  rebuilding.value = true
  buildProgress.value = { phase: 'init', message: 'Starting build...' }

  try {
    const response = await fetch(
      `/api/workspaces/${props.workspaceId}/projects/${props.projectId}/cdn/builds/trigger`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' } },
    )

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`)
    }

    const reader = response.body?.getReader()
    if (!reader) throw new Error('No stream')

    const decoder = new TextDecoder()
    let buffer = ''

    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue
        try {
          const event = JSON.parse(line.slice(6))
          buildProgress.value = event

          if (event.phase === 'complete') {
            toast.success(event.message)
            builds.value = await $fetch<CDNBuild[]>(
              `/api/workspaces/${props.workspaceId}/projects/${props.projectId}/cdn/builds`,
            )
          }
          else if (event.phase === 'error') {
            toast.error(event.message)
          }
        }
        catch { /* skip */ }
      }
    }
  }
  catch {
    toast.error(t('project_settings.save_error'))
  }
  finally {
    rebuilding.value = false
    buildProgress.value = null
  }
}

function copyKey() {
  if (!newKey.value) return
  navigator.clipboard.writeText(newKey.value)
  copied.value = true
  setTimeout(() => {
    copied.value = false
  }, 2000)
}
</script>

<template>
  <div class="flex h-full flex-col">
    <!-- Loading -->
    <div v-if="loading" class="space-y-3 p-5">
      <AtomsSkeleton v-for="i in 4" :key="i" variant="custom" class="h-12 w-full rounded-lg" />
    </div>

    <!-- Upgrade nudge (not Pro) -->
    <div v-else-if="!isPro" class="flex h-full items-center justify-center p-8">
      <AtomsEmptyState
        illustration="/illustrations/unlock-cdn.png"
        :title="t('cdn.title')"
        :description="t('cdn.pro_required')"
      >
        <template #action>
          <AtomsBadge variant="info" size="md">
            Pro — $14/mo
          </AtomsBadge>
        </template>
      </AtomsEmptyState>
    </div>

    <!-- CDN Management (Pro) -->
    <div v-else class="flex-1 overflow-y-auto">
      <!-- Toggle -->
      <div class="flex items-center justify-between border-b border-secondary-200 px-5 py-3 dark:border-secondary-800">
        <div>
          <div class="text-sm font-medium text-heading dark:text-secondary-100">
            {{ cdnActive ? t('cdn.enabled') : t('cdn.disabled') }}
          </div>
          <p class="text-xs text-muted">
            {{ t('cdn.description') }}
          </p>
        </div>
        <button
          type="button"
          role="switch"
          :aria-checked="cdnActive"
          :aria-label="cdnActive ? t('cdn.disable') : t('cdn.enable')"
          :disabled="!canManageCDN"
          class="relative inline-flex h-6 w-11 shrink-0 rounded-full border-2 border-transparent transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50"
          :class="[
            cdnActive ? 'bg-primary-500' : 'bg-secondary-200 dark:bg-secondary-700',
            !canManageCDN ? 'opacity-60' : '',
          ]"
          @click="toggleCDN"
        >
          <span
            class="pointer-events-none inline-block size-5 rounded-full bg-white shadow-sm transition-transform"
            :class="cdnActive ? 'translate-x-5' : 'translate-x-0'"
          />
        </button>
      </div>

      <template v-if="cdnActive">
        <!-- New key alert -->
        <div v-if="newKey && canManageCDN" class="mx-5 mt-4 rounded-lg border border-success-200 bg-success-50 p-3 dark:border-success-500/20 dark:bg-success-500/10">
          <p class="text-xs font-medium text-success-700 dark:text-success-400">
            {{ t('cdn.key_created') }}
          </p>
          <div class="mt-2 flex items-center gap-2">
            <code class="flex-1 truncate rounded bg-white px-2 py-1 font-mono text-[11px] text-heading dark:bg-secondary-900 dark:text-secondary-100">{{ newKey }}</code>
            <AtomsBaseButton variant="ghost" size="sm" @click="copyKey">
              <span :class="copied ? 'icon-[annon--check]' : 'icon-[annon--copy]'" class="size-3.5" aria-hidden="true" />
            </AtomsBaseButton>
          </div>
        </div>

        <!-- API Keys -->
        <div class="px-5 pt-4">
          <div class="mb-2 flex items-center gap-1">
            <AtomsSectionLabel :label="t('cdn.keys_title')" :count="activeKeys.length" />
            <AtomsInfoTooltip :text="t('cdn.keys_info')" />
          </div>

          <div v-if="activeKeys.length > 0" class="space-y-1.5">
            <div
              v-for="key in activeKeys" :key="key.id"
              class="flex items-center gap-2 rounded-lg border border-secondary-200 px-3 py-2 dark:border-secondary-800"
            >
              <span class="icon-[annon--key] size-3.5 shrink-0 text-muted" aria-hidden="true" />
              <div class="min-w-0 flex-1">
                <div class="truncate text-xs font-medium text-heading dark:text-secondary-100">
                  {{ key.name }}
                </div>
                <div class="font-mono text-[10px] text-muted">
                  {{ key.key_prefix }}...
                </div>
              </div>
              <button
                v-if="canManageCDN"
                type="button"
                class="shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium text-danger-500 transition-colors hover:bg-danger-50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-danger-500/50 dark:hover:bg-danger-900/20"
                @click="revokeKey(key.id)"
              >
                {{ t('cdn.revoke') }}
              </button>
            </div>
          </div>
          <div v-else class="flex items-center gap-2 rounded-lg border border-dashed border-secondary-200 px-3 py-3 dark:border-secondary-700">
            <span class="icon-[annon--key] size-4 text-muted" aria-hidden="true" />
            <span class="text-xs text-muted">{{ t('cdn.no_keys') }}</span>
          </div>

          <form v-if="canManageCDN" class="mt-3 flex items-center gap-2" @submit.prevent="createKey">
            <AtomsFormInput
              v-model="keyName" type="text" :placeholder="t('cdn.key_name_placeholder')" class="flex-1"
            />
            <AtomsBaseButton type="submit" variant="primary" size="sm" :disabled="!keyName.trim() || creatingKey">
              {{ t('cdn.create_key') }}
            </AtomsBaseButton>
          </form>
        </div>

        <!-- Build History -->
        <div class="px-5 pt-5">
          <div class="mb-2 flex items-center justify-between">
            <div class="flex items-center gap-1">
              <AtomsSectionLabel :label="t('cdn.builds_title')" :count="builds.length" />
              <AtomsInfoTooltip :text="t('cdn.builds_info')" />
            </div>
            <AtomsBaseButton v-if="canManageCDN" variant="ghost" size="sm" :disabled="rebuilding" @click="triggerRebuild">
              <span class="icon-[annon--arrow-swap] size-3.5" :class="rebuilding ? 'animate-spin' : ''" aria-hidden="true" />
              {{ rebuilding ? t('cdn.rebuilding') : t('cdn.rebuild') }}
            </AtomsBaseButton>
          </div>

          <!-- Build progress -->
          <div v-if="buildProgress" class="mb-3 rounded-lg border border-primary-200 bg-primary-50 p-3 dark:border-primary-500/20 dark:bg-primary-500/10">
            <div class="flex items-center gap-2">
              <div class="size-3 animate-spin rounded-full border-2 border-primary-300 border-t-primary-600" />
              <span class="flex-1 text-xs font-medium text-primary-700 dark:text-primary-300">
                {{ buildProgress.message }}
              </span>
              <span v-if="buildProgress.total" class="text-[10px] text-primary-500">
                {{ buildProgress.current }}/{{ buildProgress.total }}
              </span>
            </div>
            <div v-if="buildProgress.total" class="mt-2 h-1.5 overflow-hidden rounded-full bg-primary-200 dark:bg-primary-800">
              <div
                class="h-full rounded-full bg-primary-500 transition-all duration-300"
                :style="{ width: `${Math.round(((buildProgress.current ?? 0) / buildProgress.total) * 100)}%` }"
              />
            </div>
          </div>

          <div v-if="builds.length > 0" class="space-y-1">
            <div
              v-for="build in builds.slice(0, 8)" :key="build.id"
              class="flex items-center gap-2 rounded-md px-2 py-1.5 text-xs hover:bg-secondary-50 dark:hover:bg-secondary-900"
            >
              <AtomsBadge :variant="buildStatusVariant[build.status] ?? 'secondary'" size="sm">
                {{ t(`cdn.build_${build.status}`) }}
              </AtomsBadge>
              <span class="flex-1 truncate text-muted">
                {{ build.commit_sha.substring(0, 7) }}
                <span v-if="build.file_count"> · {{ build.file_count }} {{ t('cdn.files') }}</span>
                <span v-if="build.build_duration_ms"> · {{ build.build_duration_ms }}ms</span>
              </span>
              <span class="shrink-0 text-[10px] text-disabled">{{ build.trigger_type }}</span>
            </div>
          </div>
          <div v-else class="flex items-center gap-2 rounded-lg border border-dashed border-secondary-200 px-3 py-3 dark:border-secondary-700">
            <span class="icon-[annon--arrow-swap] size-4 text-muted" aria-hidden="true" />
            <span class="text-xs text-muted">{{ t('cdn.no_builds') }}</span>
          </div>
        </div>

        <!-- SDK Snippet -->
        <details class="group mx-5 mt-5 mb-5">
          <summary class="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-muted transition-colors hover:text-heading">
            <span class="icon-[annon--code] size-3.5" aria-hidden="true" />
            {{ t('cdn.snippet_title') }}
            <span class="icon-[annon--chevron-right] ml-auto size-3 transition-transform group-open:rotate-90" aria-hidden="true" />
          </summary>
          <pre class="mt-2 overflow-x-auto rounded-lg bg-secondary-50 p-3 text-[11px] leading-relaxed text-heading dark:bg-secondary-900 dark:text-secondary-100"><code>import { createContentrain } from '@contentrain/sdk'

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
</template>

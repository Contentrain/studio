<script setup lang="ts">
const props = defineProps<{
  workspaceId: string
  projectId: string
  editable?: boolean
}>()

const { t } = useContent()
const toast = useToast()

interface HandoffSummary {
  siteUrl: string
  generatedAt: string
  content?: { models: number, entries: number, locales: string[] }
  capabilities: Array<{ key: string, disposition: string, detail?: string }>
  needsRuntime: string[]
  offers: Array<{ capability: string, provider: string, warning?: string }>
  comments?: { total: number, hasExport: boolean, unresolved: number }
  notes: string[]
  previewUrl?: string
}

interface HandoffState {
  present: boolean
  syncedAt: string | null
  summary: HandoffSummary | null
  commentsImported: number
}

const state = ref<HandoffState | null>(null)
const busy = ref<'sync' | 'import' | null>(null)

const base = () => `/api/workspaces/${props.workspaceId}/projects/${props.projectId}/migration`

async function load() {
  try {
    state.value = await $fetch<HandoffState>(base())
  }
  catch {
    state.value = null
  }
}

watch(() => props.projectId, load, { immediate: true })

const DISPOSITION_ORDER = ['needs_runtime', 'migrated_static', 'external_adapter', 'kept_on_wordpress', 'archived', 'dropped'] as const

const groups = computed(() => {
  const summary = state.value?.summary
  if (!summary) return []
  return DISPOSITION_ORDER
    .map(disposition => ({ disposition, keys: summary.capabilities.filter(c => c.disposition === disposition).map(c => c.key) }))
    .filter(g => g.keys.length > 0)
})

const dispositionVariant: Record<string, 'warning' | 'success' | 'info' | 'secondary' | 'danger'> = {
  needs_runtime: 'warning',
  migrated_static: 'success',
  external_adapter: 'info',
  kept_on_wordpress: 'secondary',
  archived: 'secondary',
  dropped: 'danger',
}

function dispositionLabel(disposition: string): string {
  return t(`migration.${disposition}`)
}

function formatDate(value: string): string {
  const ms = Date.parse(value)
  return Number.isNaN(ms) ? value : new Date(ms).toLocaleDateString()
}

async function resync() {
  busy.value = 'sync'
  try {
    const result = await $fetch<{ found: boolean }>(`${base()}/sync`, { method: 'POST' })
    toast.success(t(result.found ? 'migration.resync_done' : 'migration.resync_missing'))
    await load()
  }
  catch {
    toast.error(t('migration.resync_failed'))
  }
  finally {
    busy.value = null
  }
}

async function importComments() {
  busy.value = 'import'
  try {
    await $fetch(`${base()}/import-comments`, { method: 'POST' })
    toast.success(t('migration.import_done'))
    await load()
  }
  catch {
    toast.error(t('migration.import_failed'))
  }
  finally {
    busy.value = null
  }
}
</script>

<template>
  <section
    v-if="state?.present && state.summary"
    class="mx-5 mt-5 rounded-xl border border-secondary-200 bg-secondary-50 p-4 dark:border-secondary-800 dark:bg-secondary-900"
  >
    <div class="flex items-start gap-3">
      <div class="flex size-8 shrink-0 items-center justify-center rounded-lg bg-info-50 dark:bg-info-900/20">
        <span class="icon-[annon--import] size-4 text-info-600 dark:text-info-400" aria-hidden="true" />
      </div>
      <div class="min-w-0 flex-1">
        <h4 class="text-sm font-semibold text-heading dark:text-secondary-100">
          {{ t('migration.card_title') }}
        </h4>
        <p class="mt-0.5 truncate text-xs text-muted">
          {{ t('migration.source') }}: <a :href="state.summary.siteUrl" target="_blank" rel="noopener" class="rounded text-primary-600 hover:text-primary-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50 dark:text-primary-400">{{ state.summary.siteUrl }}</a>
          · {{ t('migration.generated_at') }} {{ formatDate(state.summary.generatedAt) }}
        </p>
        <p v-if="state.summary.content" class="mt-0.5 text-xs text-muted">
          {{ t('migration.content_summary', { models: state.summary.content.models, entries: state.summary.content.entries }) }}
          <span v-if="state.summary.content.locales.length"> · {{ state.summary.content.locales.join(', ') }}</span>
        </p>
      </div>
      <AtomsIconButton
        v-if="editable"
        icon="icon-[annon--refresh-cw]"
        :label="t('migration.resync')"
        size="sm"
        :disabled="busy !== null"
        @click="resync"
      />
    </div>

    <dl class="mt-3 space-y-2">
      <div v-for="group in groups" :key="group.disposition" class="flex items-start gap-2">
        <dt class="w-36 shrink-0 pt-0.5 text-xs text-label">
          {{ dispositionLabel(group.disposition) }}
        </dt>
        <dd class="flex flex-wrap gap-1">
          <AtomsBadge v-for="key in group.keys" :key="key" :variant="dispositionVariant[group.disposition] ?? 'secondary'" size="sm">
            {{ key }}
          </AtomsBadge>
        </dd>
      </div>
      <div v-if="state.summary.offers.length" class="flex items-start gap-2">
        <dt class="w-36 shrink-0 pt-0.5 text-xs text-label">
          {{ t('migration.offers') }}
        </dt>
        <dd class="text-xs text-body dark:text-secondary-300">
          <span v-for="(offer, i) in state.summary.offers" :key="`${offer.capability}-${offer.provider}`">
            {{ offer.capability }} → {{ offer.provider }}<span v-if="i < state.summary.offers.length - 1">; </span>
          </span>
        </dd>
      </div>
    </dl>

    <div v-if="state.summary.comments" class="mt-3 flex flex-wrap items-center gap-2 border-t border-secondary-200 pt-3 dark:border-secondary-800">
      <span class="text-xs text-body dark:text-secondary-300">
        {{ t('migration.comments_at_source', { total: state.summary.comments.total }) }}
        · {{ t('migration.comments_imported', { count: state.commentsImported }) }}
      </span>
      <AtomsBaseButton
        v-if="editable && state.summary.comments.hasExport"
        type="button"
        variant="primary"
        size="sm"
        class="ml-auto"
        :disabled="busy !== null"
        @click="importComments"
      >
        {{ busy === 'import' ? t('common.loading') : t('migration.import_comments') }}
      </AtomsBaseButton>
    </div>

    <ul v-if="state.summary.notes.length" class="mt-3 list-disc space-y-0.5 pl-5 text-xs text-muted">
      <li v-for="note in state.summary.notes" :key="note">
        {{ note }}
      </li>
    </ul>
  </section>
</template>

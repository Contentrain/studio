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
  offers: Array<{ capability: string, provider: string, supported: boolean, warning?: string }>
  /** The offer each capability went with (one per capability). */
  chosenOffers: Array<{ capability: string, provider: string }>
  comments?: { total: number, hasExport: boolean, source: 'url' | 'inline' | 'none', unresolved: number }
  /** For the agent's context only; never shown on the card. */
  notes: string[]
  previewUrl?: string
  issues: HandoffIssue[]
}

type HandoffIssue
  = | { code: 'offer_unsupported' | 'runtime_unbound', capabilities: string[] }
    | { code: 'preview_url_missing' }
    | { code: 'comments_export_too_large', detail: string }

/** The comments export held on this repository's Migrate grant — status and count only. */
interface ClaimExport {
  status: 'ready' | 'unavailable' | 'imported' | 'expired'
  count: number
}

interface HandoffState {
  present: boolean
  syncedAt: string | null
  summary: HandoffSummary | null
  commentsImported: number
  claimExport?: ClaimExport | null
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

const claimExport = computed(() => state.value?.claimExport ?? null)
const canImport = computed(() => !!state.value?.summary?.comments?.hasExport || claimExport.value?.status === 'ready')

function claimExportText(value: ClaimExport): string {
  return t(`migration.claim_export_${value.status}`, { count: value.count })
}

const chosenOffers = computed(() => state.value?.summary?.chosenOffers ?? [])
/** Capabilities with no chosen offer recorded: every supported alternative is still open, on one line. */
const openOffers = computed(() => {
  const decided = new Set(chosenOffers.value.map(o => o.capability))
  const open = new Map<string, string[]>()
  for (const offer of state.value?.summary?.offers ?? []) {
    if (!offer.supported || decided.has(offer.capability)) continue
    open.set(offer.capability, [...(open.get(offer.capability) ?? []), offer.provider])
  }
  return [...open].map(([capability, providers]) => ({ capability, providers }))
})
/** A missing preview URL is Migrate's record keeping, nothing the customer can act on: the agent knows it, the card does not say it. */
const customerIssues = computed(() => state.value?.summary?.issues.filter(i => i.code !== 'preview_url_missing') ?? [])

function capabilityLabel(key: string): string {
  return t(`migration.capability_${key}`)
}

function providerLabel(provider: string): string {
  return t(`migration.provider_${provider}`)
}

/** `tr-tr` → "Turkish (TR)": the language's name, with the region when there is one. */
function localeLabel(code: string): string {
  const [language = '', region] = code.split(/[-_]/)
  const name = getLocaleName(language.toLowerCase())
  return region ? `${name} (${region.toUpperCase()})` : name
}

function issueText(issue: HandoffIssue): string {
  if (issue.code === 'offer_unsupported' || issue.code === 'runtime_unbound')
    return t(`migration.issue_${issue.code}`, { capabilities: issue.capabilities.map(capabilityLabel).join(', ') })
  if (issue.code === 'comments_export_too_large')
    return t('migration.issue_comments_export_too_large', { detail: issue.detail })
  return t(`migration.issue_${issue.code}`)
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
    v-if="(state?.present && state.summary) || claimExport"
    class="mx-5 mt-5 rounded-xl border border-secondary-200 bg-secondary-50 p-4 dark:border-secondary-800 dark:bg-secondary-900"
  >
    <template v-if="state?.summary">
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
            <span v-if="state.summary.content.locales.length"> · {{ state.summary.content.locales.map(localeLabel).join(', ') }}</span>
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
              {{ capabilityLabel(key) }}
            </AtomsBadge>
          </dd>
        </div>
        <div v-if="chosenOffers.length || openOffers.length" class="flex items-start gap-2">
          <dt class="w-36 shrink-0 pt-0.5 text-xs text-label">
            {{ t('migration.offers') }}
          </dt>
          <dd class="text-xs text-body dark:text-secondary-300">
            <ul class="space-y-0.5" data-testid="migration-offers">
              <li v-for="offer in chosenOffers" :key="offer.capability">
                {{ capabilityLabel(offer.capability) }}: {{ providerLabel(offer.provider) }}
              </li>
              <li v-for="offer in openOffers" :key="offer.capability">
                {{ capabilityLabel(offer.capability) }}: {{ t('migration.offer_open', { options: offer.providers.map(providerLabel).join(' / ') }) }}
              </li>
            </ul>
          </dd>
        </div>
      </dl>

      <div v-if="customerIssues.length" class="mt-3 rounded-lg border border-warning-200 bg-warning-50 px-3 py-2 dark:border-warning-800 dark:bg-warning-900/20">
        <p class="flex items-center gap-1.5 text-xs font-medium text-warning-700 dark:text-warning-300">
          <span class="icon-[annon--alert-triangle] size-3.5" aria-hidden="true" />
          {{ t('migration.issues') }}
        </p>
        <ul class="mt-1 list-disc space-y-0.5 pl-5 text-xs text-body dark:text-secondary-300">
          <li v-for="issue in customerIssues" :key="issue.code">
            {{ issueText(issue) }}
          </li>
        </ul>
      </div>
    </template>

    <div v-else class="flex items-start gap-3">
      <div class="flex size-8 shrink-0 items-center justify-center rounded-lg bg-info-50 dark:bg-info-900/20">
        <span class="icon-[annon--import] size-4 text-info-600 dark:text-info-400" aria-hidden="true" />
      </div>
      <h4 class="pt-1.5 text-sm font-semibold text-heading dark:text-secondary-100">
        {{ t('migration.card_title') }}
      </h4>
    </div>

    <div v-if="state && (state.summary?.comments || claimExport)" class="mt-3 flex flex-wrap items-center gap-2 border-t border-secondary-200 pt-3 dark:border-secondary-800" data-testid="migration-comments">
      <span class="text-xs text-body dark:text-secondary-300">
        <template v-if="state.summary?.comments">
          {{ state.summary.comments.total === 1 ? t('migration.comments_at_source_one') : t('migration.comments_at_source_many', { total: state.summary.comments.total }) }}
          ·
        </template>
        {{ t('migration.comments_imported', { count: state.commentsImported }) }}
      </span>
      <p v-if="claimExport" class="w-full text-xs text-muted" data-testid="migration-claim-export">
        {{ claimExportText(claimExport) }}
      </p>
      <AtomsBaseButton
        v-if="editable && canImport"
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

    <OrganismsMigrationMediaCard v-if="state?.summary" :workspace-id="workspaceId" :project-id="projectId" :editable="editable" />
  </section>
</template>

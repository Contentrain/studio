<script setup lang="ts">
/**
 * A migration's media → Studio Media, inside the migration card: what is in
 * the repository, what is still on the old site, and what the plan takes
 * (preflight), the import's progress,
 * and — once every file is in — switching the site's addresses to Studio.
 *
 * Opened with `?focus=migration-media` (the claim screen's way here from
 * Migrate's "move the media to Studio"), the card scrolls into view.
 */
const props = defineProps<{
  workspaceId: string
  projectId: string
  editable?: boolean
}>()

const { t } = useContent()
const route = useRoute()
const root = ref<HTMLElement | null>(null)
const toast = useToast()
const { show: showPlanModal } = usePlanModal()

type JobStatus = 'preparing' | 'queued' | 'running' | 'paused_quota' | 'done' | 'failed' | 'canceled'
interface JobView {
  id: string
  status: JobStatus
  total: number
  done: number
  failed: number
  deduped: number
  pending: number
  bytesDone: number
  error: string | null
  failures?: Array<{ repoPath: string, error: string | null }>
}
interface Preflight {
  count: number
  totalBytes: number
  overSize: Array<{ repoPath: string, bytes: number }>
  missing: Array<{ repoPath: string, reason: string }>
  fontsKept: number
  refs: number
  /** Files still at the old site's address, fetched from there by the same import. */
  onOrigin?: { count: number, knownBytes: number, overSize: Array<{ url: string, bytes: number }>, offOrigin: number, unverified?: number }
  limits: { maxFileBytes: number | null, storageBytes: number | null }
  storage: { usedBytes: number, remainingBytes: number | null }
  fits: boolean
  upgrade: { plan: string } | null
}
interface MediaState {
  present: boolean
  job?: JobView | null
  uploadAllowed?: boolean
  preflight?: Preflight
}
interface ApplyCounts {
  filesChanged: number
  rewritten: number
  drifted: unknown[]
  notImported: string[]
  originNotImported?: string[]
  remaining: unknown[]
  deleted: number
  keptBecause: string | null
}

const state = ref<MediaState | null>(null)
const job = ref<JobView | null>(null)
const busy = ref<'start' | 'resume' | 'preview' | 'apply' | null>(null)
const applyPreview = ref<ApplyCounts | null>(null)
const deleteLocal = ref(false)
let timer: ReturnType<typeof setTimeout> | undefined

const base = () => `/api/workspaces/${props.workspaceId}/projects/${props.projectId}/migration/media`

async function load() {
  try {
    state.value = await $fetch<MediaState>(base())
    job.value = state.value.job ?? null
  }
  catch {
    state.value = null
  }
  schedule()
}

// Once, when the card first shows.
const stopFocus = watch(root, (el) => {
  if (!el) return
  if (route.query.focus === 'migration-media') el.scrollIntoView({ behavior: 'smooth', block: 'center' })
  stopFocus()
}, { flush: 'post' })

const active = computed(() => !!job.value && ['preparing', 'queued', 'running'].includes(job.value.status))

function schedule() {
  if (timer) clearTimeout(timer)
  if (!active.value || !job.value) return
  timer = setTimeout(async () => {
    try {
      job.value = (await $fetch<{ job: JobView }>(`${base()}/jobs/${job.value!.id}`)).job
    }
    catch { /* keep the last reading; the next load recovers */ }
    schedule()
  }, 3000)
}

watch(() => props.projectId, load, { immediate: true })
onBeforeUnmount(() => {
  if (timer) clearTimeout(timer)
})

const preflight = computed(() => state.value?.preflight ?? null)
const onOrigin = computed(() => preflight.value?.onOrigin ?? null)
const movable = computed(() => preflight.value ? preflight.value.count - preflight.value.overSize.length - preflight.value.missing.length + (onOrigin.value?.count ?? 0) : 0)
const movableBytes = computed(() => (preflight.value?.totalBytes ?? 0) - (preflight.value?.overSize.reduce((s, a) => s + a.bytes, 0) ?? 0) + (onOrigin.value?.knownBytes ?? 0))
const needsUpgrade = computed(() => state.value?.uploadAllowed === false || !!preflight.value?.upgrade)
const canStart = computed(() => props.editable && state.value?.uploadAllowed && movable.value > 0 && (!job.value || job.value.status === 'failed'))
const progress = computed(() => (job.value && job.value.total > 0 ? Math.round(((job.value.done + job.value.failed) / job.value.total) * 100) : 0))

function size(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

async function start() {
  busy.value = 'start'
  try {
    job.value = (await $fetch<{ job: JobView }>(base(), { method: 'POST' })).job
    schedule()
  }
  catch {
    toast.error(t('migration.media_start_failed'))
  }
  finally {
    busy.value = null
  }
}

async function resume() {
  if (!job.value) return
  busy.value = 'resume'
  try {
    job.value = (await $fetch<{ job: JobView }>(`${base()}/jobs/${job.value.id}/resume`, { method: 'POST' })).job
    schedule()
  }
  catch {
    toast.error(t('migration.media_resume_failed'))
  }
  finally {
    busy.value = null
  }
}

async function preview() {
  busy.value = 'preview'
  try {
    applyPreview.value = (await $fetch<{ counts: ApplyCounts }>(`${base()}/apply`, { method: 'POST', body: { dryRun: true, deleteLocal: deleteLocal.value } })).counts
  }
  catch {
    toast.error(t('migration.media_apply_failed'))
  }
  finally {
    busy.value = null
  }
}

async function apply() {
  busy.value = 'apply'
  try {
    const result = await $fetch<{ status: string }>(`${base()}/apply`, { method: 'POST', body: { dryRun: false, deleteLocal: deleteLocal.value } })
    toast.success(t(result.status === 'pending_review' ? 'migration.media_apply_pending' : result.status === 'nothing_to_do' ? 'migration.media_apply_nothing' : 'migration.media_apply_done'))
    applyPreview.value = null
  }
  catch {
    toast.error(t('migration.media_apply_failed'))
  }
  finally {
    busy.value = null
  }
}

watch(deleteLocal, () => {
  if (applyPreview.value) void preview()
})
</script>

<template>
  <div v-if="state?.present && preflight" id="migration-media" ref="root" class="mt-3 border-t border-secondary-200 pt-3 dark:border-secondary-800" data-testid="migration-media">
    <p class="text-xs font-medium text-heading dark:text-secondary-100">
      {{ t('migration.media_title') }}
    </p>
    <p class="mt-0.5 text-xs text-body dark:text-secondary-300">
      {{ t('migration.media_summary', { count: preflight.count, size: size(preflight.totalBytes) }) }}
      <span v-if="preflight.fontsKept"> · {{ t('migration.media_fonts_kept', { count: preflight.fontsKept }) }}</span>
    </p>
    <p class="mt-1 text-xs text-muted">
      {{ t('migration.media_public_note') }}
    </p>

    <ul v-if="onOrigin && (onOrigin.count || onOrigin.offOrigin || onOrigin.unverified)" class="mt-2 list-disc space-y-0.5 pl-5 text-xs text-body dark:text-secondary-300" data-testid="migration-media-origin">
      <li v-if="onOrigin.count">
        {{ t('migration.media_on_origin', { count: onOrigin.count }) }}
      </li>
      <li v-if="onOrigin.offOrigin">
        {{ t('migration.media_off_origin', { count: onOrigin.offOrigin }) }}
      </li>
      <li v-if="onOrigin.unverified">
        {{ t('migration.media_origin_unverified', { count: onOrigin.unverified }) }}
      </li>
    </ul>

    <ul v-if="preflight.overSize.length || preflight.missing.length || onOrigin?.overSize.length" class="mt-2 list-disc space-y-0.5 pl-5 text-xs text-body dark:text-secondary-300">
      <li v-if="preflight.overSize.length">
        {{ t('migration.media_over_size', { count: preflight.overSize.length, limit: preflight.limits.maxFileBytes ? size(preflight.limits.maxFileBytes) : '' }) }}
      </li>
      <li v-if="preflight.missing.length">
        {{ t('migration.media_missing', { count: preflight.missing.length }) }}
      </li>
      <li v-if="onOrigin?.overSize.length">
        {{ t('migration.media_origin_over_size', { count: onOrigin.overSize.length, limit: preflight.limits.maxFileBytes ? size(preflight.limits.maxFileBytes) : '' }) }}
      </li>
    </ul>

    <div v-if="needsUpgrade || (preflight && !preflight.fits)" class="mt-2 flex flex-wrap items-center gap-2 rounded-lg border border-warning-200 bg-warning-50 px-3 py-2 dark:border-warning-800 dark:bg-warning-900/20">
      <span class="text-xs text-body dark:text-secondary-300">
        {{ state.uploadAllowed === false ? t('migration.media_needs_plan') : t('migration.media_needs_room', { size: size(movableBytes) }) }}
      </span>
      <AtomsBaseButton v-if="editable" type="button" variant="secondary" size="sm" class="ml-auto" @click="showPlanModal()">
        {{ t('migration.media_upgrade') }}
      </AtomsBaseButton>
    </div>

    <div v-if="canStart" class="mt-2 flex">
      <AtomsBaseButton type="button" variant="primary" size="sm" :disabled="busy !== null" @click="start">
        {{ busy === 'start' ? t('common.loading') : t('migration.media_move', { count: movable, size: size(movableBytes) }) }}
      </AtomsBaseButton>
    </div>

    <div v-if="job && job.status !== 'done'" class="mt-2 space-y-1">
      <div
        class="h-1.5 overflow-hidden rounded-full bg-secondary-200 dark:bg-secondary-800"
        role="progressbar"
        :aria-valuenow="progress"
        aria-valuemin="0"
        aria-valuemax="100"
        :aria-label="t('migration.media_progress_label')"
      >
        <div class="h-full bg-primary-500 transition-all" :style="{ width: `${progress}%` }" />
      </div>
      <p class="text-xs text-muted">
        {{ t(`migration.media_status_${job.status}`, { done: job.done, total: job.total, failed: job.failed }) }}
      </p>
      <AtomsBaseButton v-if="editable && job.status === 'paused_quota'" type="button" variant="secondary" size="sm" :disabled="busy !== null" @click="resume">
        {{ t('migration.media_resume') }}
      </AtomsBaseButton>
    </div>

    <div v-if="job?.status === 'done'" class="mt-2 space-y-2">
      <p class="text-xs text-body dark:text-secondary-300">
        {{ t('migration.media_done', { done: job.done, failed: job.failed, deduped: job.deduped }) }}
      </p>
      <template v-if="editable">
        <AtomsFormSwitch v-model="deleteLocal" :label="t('migration.media_delete_local')" />
        <div v-if="applyPreview" class="text-xs text-body dark:text-secondary-300">
          <p>{{ t('migration.media_apply_preview', { refs: applyPreview.rewritten, files: applyPreview.filesChanged }) }}</p>
          <p v-if="applyPreview.drifted.length" class="text-warning-700 dark:text-warning-300">
            {{ t('migration.media_apply_drifted', { count: applyPreview.drifted.length }) }}
          </p>
          <p v-if="applyPreview.originNotImported?.length" class="text-warning-700 dark:text-warning-300">
            {{ t('migration.media_apply_origin_left', { count: applyPreview.originNotImported.length }) }}
          </p>
          <p v-if="deleteLocal && applyPreview.keptBecause && applyPreview.keptBecause !== 'not_requested'" class="text-muted">
            {{ t(`migration.media_kept_${applyPreview.keptBecause}`) }}
          </p>
        </div>
        <div class="flex gap-2">
          <AtomsBaseButton type="button" variant="secondary" size="sm" :disabled="busy !== null" @click="preview">
            {{ busy === 'preview' ? t('common.loading') : t('migration.media_apply_check') }}
          </AtomsBaseButton>
          <AtomsBaseButton v-if="applyPreview" type="button" variant="primary" size="sm" :disabled="busy !== null" @click="apply">
            {{ busy === 'apply' ? t('common.loading') : t('migration.media_apply') }}
          </AtomsBaseButton>
        </div>
      </template>
    </div>
  </div>
</template>

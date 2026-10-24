<script setup lang="ts">
/**
 * The setup's images step: the migration's images → Studio Media, and the site pointed at them.
 *
 * One Move click is the owner's approval through to the merge: the import job records the clicker
 * (`applyWhenDone`) and the worker that closes it points the pages at Studio and merges under that approval, so the
 * move goes on with the window closed. What the step shows comes from the setup's reason code; the preflight
 * (`GET …/migration/media`) gives the counts, the plan's limits and whether image delivery would serve the switched
 * addresses (`deliveryBlocked`) — the Move waits until it would.
 */
import type { MigrationSetupStep } from '~/composables/useMigrationSetup'

const props = defineProps<{
  base: string
  step: MigrationSetupStep
  jobId: string | null
  /** Files the plan refused on the grant's own move (they still load from WordPress). */
  refusedTooLarge: number | null
  reload: () => Promise<void>
}>()

const emit = defineEmits<{
  back: []
  next: []
  skip: []
}>()

const { t } = useContent()
const router = useRouter()
const { show: showPlanModal } = usePlanModal()

type JobStatus = 'preparing' | 'queued' | 'running' | 'paused_quota' | 'done' | 'failed' | 'canceled'
interface JobView { id: string, status: JobStatus, total: number, done: number, failed: number }
interface Preflight {
  count: number
  totalBytes: number
  overSize: Array<{ repoPath: string, bytes: number }>
  missing: Array<{ repoPath: string }>
  fontsKept: number
  files: number
  onOrigin?: { count: number, knownBytes: number, overSize: Array<{ url: string, bytes: number }> }
  limits: { maxFileBytes: number | null }
  fits: boolean
}
type DeliveryBlock = 'cdn_disabled' | 'public_media_off' | 'plan'
interface MediaState { present: boolean, job?: JobView | null, uploadAllowed?: boolean, deliveryBlocked?: DeliveryBlock, preflight?: Preflight }

const media = ref<MediaState | null>(null)
const job = ref<JobView | null>(null)
const deleteLocal = ref(false)
const showRefused = ref(false)
const busy = ref<'move' | 'resume' | 'apply' | 'approve' | null>(null)
const error = ref<string | null>(null)
let timer: ReturnType<typeof setTimeout> | undefined

async function loadMedia() {
  try {
    media.value = await $fetch<MediaState>(`${props.base}/media`)
    job.value = media.value.job ?? null
  }
  catch {
    media.value = null
  }
}

onMounted(loadMedia)
onBeforeUnmount(() => {
  if (timer) clearTimeout(timer)
})

const reason = computed(() => props.step.reason)
const moving = computed(() => ['importing', 'applying', 'paused_quota'].includes(reason.value))

/** While the move runs: the job every 3 s; once it is done (the apply under way), the setup until the step moves on. */
function schedule() {
  if (timer) clearTimeout(timer)
  if (!moving.value || reason.value === 'paused_quota') return
  timer = setTimeout(async () => {
    const id = job.value?.id ?? props.jobId
    if (reason.value === 'importing' && id) {
      try {
        job.value = (await $fetch<{ job: JobView }>(`${props.base}/media/jobs/${id}`)).job
      }
      catch { /* keep the last reading */ }
      if (job.value && job.value.status !== 'running' && job.value.status !== 'queued' && job.value.status !== 'preparing') await props.reload()
    }
    else {
      await props.reload()
    }
    schedule()
  }, 3000)
}
watch(reason, schedule, { immediate: true })

const preflight = computed(() => media.value?.preflight ?? null)
const originRefused = computed(() => preflight.value?.onOrigin?.overSize ?? [])
const refusedCount = computed(() => Math.max(props.refusedTooLarge ?? 0, originRefused.value.length))
const movable = computed(() => preflight.value ? preflight.value.count - preflight.value.overSize.length - preflight.value.missing.length + (preflight.value.onOrigin?.count ?? 0) : 0)
const movableBytes = computed(() => (preflight.value?.totalBytes ?? 0) - (preflight.value?.overSize.reduce((s, a) => s + a.bytes, 0) ?? 0) + (preflight.value?.onOrigin?.knownBytes ?? 0))
const pages = computed(() => preflight.value?.files ?? 0)
const blocked = computed(() => media.value?.deliveryBlocked ?? null)
const noRoom = computed(() => media.value?.uploadAllowed === false || (!!preflight.value && !preflight.value.fits))
const canMove = computed(() => movable.value > 0 && !blocked.value && !noRoom.value)
const limit = computed(() => preflight.value?.limits.maxFileBytes ? size(preflight.value.limits.maxFileBytes) : null)
const copied = computed(() => job.value ? job.value.done : 0)
const total = computed(() => job.value ? job.value.total : movable.value)
const progress = computed(() => (total.value > 0 ? Math.round((copied.value / total.value) * 100) : 0))

function size(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

function fileName(path: string): string {
  return decodeURIComponent(path.split(/[?#]/)[0]!.split('/').pop() || path)
}

async function run(kind: NonNullable<typeof busy.value>, call: () => Promise<unknown>) {
  busy.value = kind
  error.value = null
  try {
    await call()
    await props.reload()
  }
  catch (err) {
    error.value = resolveApiError(err, t('migration_setup.action_failed'))
  }
  finally {
    busy.value = null
  }
}

const move = () => run('move', async () => {
  if (props.step.state === 'skipped') await $fetch(`${props.base}/setup`, { method: 'POST', body: { unskip: 'images' } })
  job.value = (await $fetch<{ job: JobView }>(`${props.base}/media`, { method: 'POST', body: { applyWhenDone: true, deleteLocal: deleteLocal.value } })).job
})
const resume = () => run('resume', async () => {
  const id = job.value?.id ?? props.jobId
  if (id) job.value = (await $fetch<{ job: JobView }>(`${props.base}/media/jobs/${id}/resume`, { method: 'POST' })).job
})
const apply = () => run('apply', () => $fetch(`${props.base}/media/apply`, { method: 'POST', body: { dryRun: false, deleteLocal: deleteLocal.value } }))
const approve = () => run('approve', () => $fetch(`${props.base}/media/approve`, { method: 'POST' }))

function openCdn() {
  void router.replace({ query: { cdn: 'true' } })
}
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col" data-testid="setup-images" :data-reason="reason">
    <div class="flex-1 space-y-4 overflow-y-auto px-6 py-6">
      <!-- The move under way -->
      <template v-if="moving">
        <div class="space-y-2">
          <AtomsHeadingText :level="3" size="xl" weight="bold">
            {{ t('migration_setup.images_moving_title') }}
          </AtomsHeadingText>
          <p class="text-sm leading-relaxed text-body dark:text-secondary-300">
            {{ t('migration_setup.images_moving_body') }}
          </p>
        </div>
        <div class="space-y-1.5">
          <div
            class="h-1.5 overflow-hidden rounded-full bg-secondary-200 dark:bg-secondary-800"
            role="progressbar"
            :aria-valuenow="progress"
            aria-valuemin="0"
            aria-valuemax="100"
            :aria-label="t('migration_setup.images_progress_label')"
          >
            <div class="h-full bg-primary-500 transition-all" :style="{ width: `${reason === 'applying' ? 100 : progress}%` }" />
          </div>
          <p class="text-xs text-muted">
            {{ t('migration_setup.images_copied', { done: reason === 'applying' ? total : copied, total }) }}
          </p>
        </div>
        <ul class="space-y-2 text-sm">
          <li class="flex items-start gap-2">
            <span :class="reason === 'applying' ? 'icon-[annon--check-circle] text-success-600 dark:text-success-400' : 'icon-[annon--loader] animate-spin text-primary-600 dark:text-primary-400'" class="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            <span class="text-body dark:text-secondary-300">{{ t('migration_setup.images_step_copy') }}</span>
          </li>
          <li class="flex items-start gap-2">
            <span :class="reason === 'applying' ? 'icon-[annon--loader] animate-spin text-primary-600 dark:text-primary-400' : 'icon-[annon--clock] text-muted'" class="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            <span class="text-body dark:text-secondary-300">{{ t('migration_setup.images_step_point', { pages }) }}</span>
          </li>
        </ul>
        <div v-if="reason === 'paused_quota'" class="flex flex-wrap items-center gap-2 rounded-lg border border-warning-200 bg-warning-50 px-3 py-2 dark:border-warning-800 dark:bg-warning-900/20">
          <span class="flex-1 text-xs text-body dark:text-secondary-300">{{ t('migration_setup.images_paused', { done: copied, total }) }}</span>
          <AtomsBaseButton type="button" variant="secondary" size="sm" @click="showPlanModal()">
            {{ t('migration_setup.compare_plans') }}
          </AtomsBaseButton>
        </div>
      </template>

      <!-- Approve the move held for review -->
      <template v-else-if="reason === 'review'">
        <div class="space-y-2">
          <AtomsHeadingText :level="3" size="xl" weight="bold">
            {{ t('migration_setup.images_review_title') }}
          </AtomsHeadingText>
          <p class="text-sm leading-relaxed text-body dark:text-secondary-300">
            {{ t('migration_setup.images_review_body') }}
          </p>
        </div>
      </template>

      <!-- A pull request into a protected branch -->
      <template v-else-if="reason === 'pull_request'">
        <div class="space-y-2">
          <AtomsHeadingText :level="3" size="xl" weight="bold">
            {{ t('migration_setup.images_pr_title') }}
          </AtomsHeadingText>
          <p class="text-sm leading-relaxed text-body dark:text-secondary-300">
            {{ t('migration_setup.images_pr_body') }}
          </p>
          <a v-if="step.pullRequestUrl" :href="step.pullRequestUrl" target="_blank" rel="noopener" class="inline-flex rounded text-sm font-medium text-primary-600 hover:text-primary-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50 dark:text-primary-400">
            {{ t('migration_setup.open_pull_request') }}
          </a>
        </div>
      </template>

      <!-- Copied, not pointed at yet -->
      <template v-else-if="reason === 'apply_pending' || reason === 'apply_failed'">
        <div class="space-y-2">
          <AtomsHeadingText :level="3" size="xl" weight="bold">
            {{ t('migration_setup.images_point_title') }}
          </AtomsHeadingText>
          <p class="text-sm leading-relaxed text-body dark:text-secondary-300">
            {{ t('migration_setup.images_point_body', { pages }) }}
          </p>
        </div>
        <p v-if="reason === 'apply_failed'" class="rounded-lg border border-warning-200 bg-warning-50 px-3 py-2 text-xs text-body dark:border-warning-800 dark:bg-warning-900/20 dark:text-secondary-300">
          {{ t('migration_setup.images_apply_failed') }}
        </p>
      </template>

      <!-- Done -->
      <template v-else-if="reason === 'moved' || reason === 'nothing'">
        <div class="space-y-2">
          <AtomsHeadingText :level="3" size="xl" weight="bold">
            {{ reason === 'moved' ? t('migration_setup.images_moved_title') : t('migration_setup.images_nothing_title') }}
          </AtomsHeadingText>
          <p class="text-sm leading-relaxed text-body dark:text-secondary-300">
            {{ reason === 'moved' ? t('migration_setup.images_moved_body') : t('migration_setup.images_nothing_body') }}
          </p>
        </div>
      </template>

      <!-- Ready to move (or a move to start again) -->
      <template v-else>
        <div class="space-y-2">
          <AtomsHeadingText :level="3" size="xl" weight="bold">
            {{ t('migration_setup.images_title') }}
          </AtomsHeadingText>
          <p v-if="preflight" class="text-sm leading-relaxed text-body dark:text-secondary-300">
            {{ t('migration_setup.images_body', { count: movable, size: size(movableBytes) }) }}
          </p>
        </div>
        <p v-if="reason === 'failed'" class="rounded-lg border border-warning-200 bg-warning-50 px-3 py-2 text-xs text-body dark:border-warning-800 dark:bg-warning-900/20 dark:text-secondary-300">
          {{ t('migration_setup.images_failed', { done: job?.done ?? 0, total: job?.total ?? movable }) }}
        </p>
        <AtomsSkeleton v-if="!media" variant="custom" class="h-20 w-full rounded-xl" />
        <dl v-else-if="preflight" class="grid grid-cols-3 gap-2.5">
          <div class="rounded-xl border border-secondary-200 px-3.5 py-3 max-sm:px-2.5 dark:border-secondary-800">
            <dd class="text-xl font-semibold text-heading dark:text-secondary-100">
              {{ movable }}
            </dd>
            <dt class="text-xs text-muted">
              {{ t('migration_setup.images_stat_move') }}
            </dt>
          </div>
          <div class="rounded-xl border border-secondary-200 px-3.5 py-3 max-sm:px-2.5 dark:border-secondary-800">
            <dd class="text-xl font-semibold text-heading dark:text-secondary-100">
              {{ pages }}
            </dd>
            <dt class="text-xs text-muted">
              {{ t('migration_setup.images_stat_pages') }}
            </dt>
          </div>
          <div class="rounded-xl border border-secondary-200 px-3.5 py-3 max-sm:px-2.5 dark:border-secondary-800">
            <dd class="text-xl font-semibold text-heading dark:text-secondary-100">
              {{ preflight.fontsKept }}
            </dd>
            <dt class="text-xs text-muted">
              {{ t('migration_setup.images_stat_fonts') }}
            </dt>
          </div>
        </dl>
        <p v-if="preflight?.overSize.length" class="text-xs text-muted">
          {{ t('migration_setup.images_repo_over_size', { count: preflight.overSize.length, limit: limit ?? '' }) }}
        </p>

        <div v-if="media && !blocked && !noRoom" class="flex items-center gap-2.5 rounded-lg bg-success-50 px-3.5 py-2.5 text-sm text-success-700 dark:bg-success-900/20 dark:text-success-300" data-testid="setup-images-delivery-on">
          <span class="icon-[annon--check] size-4 shrink-0" aria-hidden="true" />
          {{ t('migration_setup.images_delivery_on') }}
        </div>
        <div v-if="blocked" class="flex flex-wrap items-center gap-2 rounded-lg border border-warning-200 bg-warning-50 px-3 py-2 dark:border-warning-800 dark:bg-warning-900/20" data-testid="setup-images-delivery-blocked">
          <span class="flex-1 text-xs text-body dark:text-secondary-300">{{ t(`migration_setup.images_blocked_${blocked}`) }}</span>
          <AtomsBaseButton v-if="blocked === 'cdn_disabled'" type="button" variant="secondary" size="sm" @click="openCdn">
            {{ t('migration_setup.images_open_cdn') }}
          </AtomsBaseButton>
          <AtomsBaseButton v-else-if="blocked === 'plan'" type="button" variant="secondary" size="sm" @click="showPlanModal()">
            {{ t('migration_setup.compare_plans') }}
          </AtomsBaseButton>
        </div>
        <div v-if="noRoom" class="flex flex-wrap items-center gap-2 rounded-lg border border-warning-200 bg-warning-50 px-3 py-2 dark:border-warning-800 dark:bg-warning-900/20">
          <span class="flex-1 text-xs text-body dark:text-secondary-300">
            {{ media?.uploadAllowed === false ? t('migration_setup.images_needs_plan') : t('migration_setup.images_needs_room', { size: size(movableBytes) }) }}
          </span>
          <AtomsBaseButton type="button" variant="secondary" size="sm" @click="showPlanModal()">
            {{ t('migration_setup.compare_plans') }}
          </AtomsBaseButton>
        </div>

        <label class="flex items-center gap-4 rounded-xl border border-secondary-200 px-4 py-3.5 dark:border-secondary-800">
          <span class="flex flex-1 flex-col gap-1">
            <span class="text-sm font-medium text-heading dark:text-secondary-100">{{ t('migration_setup.images_delete_local') }}</span>
            <span class="text-xs text-muted">{{ t('migration_setup.images_delete_local_note') }}</span>
          </span>
          <input v-model="deleteLocal" type="checkbox" class="size-5 rounded border-secondary-300 accent-primary-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50 dark:border-secondary-600">
        </label>
        <p class="text-xs leading-relaxed text-muted">
          {{ t('migration_setup.images_approval', { pages }) }}
        </p>
      </template>

      <!-- Files the plan refused: they still load from WordPress (the summary's "What to do" lands here) -->
      <div v-if="refusedCount && (moving || reason === 'moved' || refusedTooLarge)" class="rounded-lg border border-warning-200 bg-warning-50 px-3.5 py-3 dark:border-warning-800 dark:bg-warning-900/20" data-testid="setup-images-refused">
        <p class="text-sm font-medium text-heading dark:text-secondary-100">
          {{ t('migration_setup.images_refused_title', { count: refusedCount }) }}
        </p>
        <p class="mt-1 text-xs leading-relaxed text-body dark:text-secondary-300">
          {{ limit ? t('migration_setup.images_refused_body_limit', { limit }) : t('migration_setup.images_refused_body') }}
        </p>
        <div class="mt-2 flex flex-wrap gap-3">
          <button
            v-if="originRefused.length"
            type="button"
            class="rounded text-xs font-medium text-primary-600 hover:text-primary-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50 dark:text-primary-400"
            :aria-expanded="showRefused"
            @click="showRefused = !showRefused"
          >
            {{ t('migration_setup.images_refused_list', { count: originRefused.length }) }}
          </button>
          <button type="button" class="rounded text-xs font-medium text-primary-600 hover:text-primary-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50 dark:text-primary-400" @click="showPlanModal()">
            {{ t('migration_setup.compare_plans') }}
          </button>
        </div>
        <ul v-if="showRefused" class="mt-2 space-y-0.5 text-xs text-body dark:text-secondary-300">
          <li v-for="file in originRefused" :key="file.url" class="truncate">
            {{ fileName(file.url) }} · {{ size(file.bytes) }}
          </li>
        </ul>
      </div>

      <p v-if="error" class="text-xs text-danger-600 dark:text-danger-400" role="alert">
        {{ error }}
      </p>
    </div>

    <div class="flex shrink-0 flex-wrap items-center gap-2 border-t border-secondary-200 px-6 py-4 max-sm:flex-col-reverse max-sm:items-stretch dark:border-secondary-800">
      <AtomsBaseButton type="button" @click="emit('back')">
        {{ t('migration_setup.back') }}
      </AtomsBaseButton>
      <div class="ml-auto flex flex-wrap items-center justify-end gap-2 max-sm:ml-0 max-sm:flex-col-reverse max-sm:items-stretch">
        <template v-if="moving">
          <span v-if="reason !== 'paused_quota'" class="text-xs text-muted max-sm:text-center">{{ t('migration_setup.images_step5_note') }}</span>
          <AtomsBaseButton v-if="reason === 'paused_quota'" type="button" variant="primary" :disabled="busy !== null" @click="resume">
            {{ busy === 'resume' ? t('common.loading') : t('migration_setup.images_resume') }}
          </AtomsBaseButton>
          <AtomsBaseButton v-else type="button" variant="primary" disabled>
            {{ t('migration_setup.continue') }}
          </AtomsBaseButton>
        </template>
        <AtomsBaseButton v-else-if="reason === 'review'" type="button" variant="primary" :disabled="busy !== null" @click="approve">
          {{ busy === 'approve' ? t('common.loading') : t('migration_setup.images_approve') }}
        </AtomsBaseButton>
        <AtomsBaseButton v-else-if="reason === 'apply_pending' || reason === 'apply_failed'" type="button" variant="primary" :disabled="busy !== null" @click="apply">
          {{ busy === 'apply' ? t('common.loading') : t('migration_setup.images_point') }}
        </AtomsBaseButton>
        <AtomsBaseButton v-else-if="reason === 'pull_request' || reason === 'moved' || reason === 'nothing'" type="button" variant="primary" @click="emit('next')">
          {{ t('migration_setup.continue') }}
        </AtomsBaseButton>
        <template v-else>
          <AtomsBaseButton type="button" variant="secondary" :disabled="busy !== null" @click="emit('skip')">
            {{ t('migration_setup.images_skip') }}
          </AtomsBaseButton>
          <AtomsBaseButton type="button" variant="primary" :disabled="busy !== null || !canMove" @click="move">
            {{ busy === 'move' ? t('common.loading') : t('migration_setup.images_move', { count: movable }) }}
          </AtomsBaseButton>
        </template>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * The setup of a project Migrate delivered: "your site is in Studio", then four steps — forms and comments run with
 * Studio, the old comments, the images to Studio Media, the live site checked. Each screen follows its step's state
 * (`GET …/migration` `setup`) and offers one primary click; skipping a step only stops the setup asking.
 *
 * Under 640 px the dialog is a full-height sheet. A click outside does not close it; the close button and Escape do.
 */
import { DialogClose, DialogContent, DialogDescription, DialogOverlay, DialogPortal, DialogRoot, DialogTitle } from 'radix-vue'
import type { MigrationSetupScreen, MigrationSetupStep, MigrationSetupStepName, MigrationState } from '~/composables/useMigrationSetup'
import { MIGRATION_SETUP_STEP_NAMES, migrationSetupOpen } from '~/composables/useMigrationSetup'

const props = defineProps<{
  state: MigrationState
  base: string
  repoFullName: string | null
  models: ReadonlyArray<{ readonly id: string, readonly name: string }>
  content: Readonly<Record<string, { readonly count: number }>>
  reviewWorkflow?: boolean
  reload: () => Promise<void>
}>()

const open = defineModel<boolean>('open', { default: false })
const screen = defineModel<MigrationSetupScreen>('screen', { default: 'main' })

const { t } = useContent()
const router = useRouter()

const setup = computed(() => props.state.setup)
const step = (name: MigrationSetupStepName): MigrationSetupStep => setup.value?.steps.find(s => s.step === name) ?? { step: name, state: 'needs_you', reason: '' }
const current = computed(() => screen.value === 'main' ? null : step(screen.value))

const siteUrl = computed(() => props.state.summary?.siteUrl ?? '')
const siteName = computed(() => {
  try {
    return new URL(siteUrl.value).hostname.replace(/^www\./, '')
  }
  catch {
    return siteUrl.value
  }
})

const busy = ref<string | null>(null)
const error = ref<string | null>(null)
/** Turned on in this window: the comments screen says the host is rebuilding the site. */
const justBound = ref(false)

watch(screen, () => {
  error.value = null
})

async function run(kind: string, call: () => Promise<unknown>) {
  busy.value = kind
  error.value = null
  try {
    await call()
    await props.reload()
    return true
  }
  catch (err) {
    error.value = resolveApiError(err, t('migration_setup.action_failed'))
    return false
  }
  finally {
    busy.value = null
  }
}

const post = (path: string, body?: Record<string, unknown>) => $fetch(`${props.base}${path}`, { method: 'POST', body })
/** A skipped step taken up again: its click counts only once it is not skipped. */
const unskip = (name: MigrationSetupStepName) => step(name).state === 'skipped' ? post('/setup', { unskip: name }) : Promise.resolve()

function goNext(from: MigrationSetupScreen) {
  const at = from === 'main' ? -1 : MIGRATION_SETUP_STEP_NAMES.indexOf(from)
  const next = MIGRATION_SETUP_STEP_NAMES.slice(at + 1).find(name => migrationSetupOpen(step(name)))
  if (next) screen.value = next
  else if (from === 'live' || MIGRATION_SETUP_STEP_NAMES.every(name => !migrationSetupOpen(step(name)))) open.value = false
  else screen.value = MIGRATION_SETUP_STEP_NAMES[at + 1] ?? 'live'
}

function goBack(from: MigrationSetupStepName) {
  const at = MIGRATION_SETUP_STEP_NAMES.indexOf(from)
  screen.value = at > 0 ? MIGRATION_SETUP_STEP_NAMES[at - 1]! : 'main'
}

async function skip(name: MigrationSetupStepName) {
  if (await run(`skip-${name}`, () => post('/setup', { skip: name }))) goNext(name)
}

// ── Stepper ──
const STEP_LABEL: Record<MigrationSetupStepName, string> = { forms: 'migration_setup.step_forms', comments: 'migration_setup.step_comments', images: 'migration_setup.step_images', live: 'migration_setup.step_live' }
const stepper = computed(() => [
  { key: 'main' as const, n: 1, label: t('migration_setup.step_connected'), state: 'done' as const },
  ...MIGRATION_SETUP_STEP_NAMES.map((name, i) => ({ key: name, n: i + 2, label: t(STEP_LABEL[name]), state: step(name).state })),
])

// ── Main ──
const contentLine = computed(() => {
  const counted = props.models
    .map(m => ({ name: m.name, count: props.content[m.id]?.count ?? 0 }))
    .filter(m => m.count > 0)
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
  const shown = counted.slice(0, 3).map(m => t('migration_setup.content_item', { name: m.name, count: m.count })).join(', ')
  return counted.length > 3 ? t('migration_setup.content_more', { items: shown, count: counted.length - 3 }) : shown
})
const PLAN_NAMES = new Set(['starter', 'pro', 'enterprise'])
const planName = computed(() => {
  const plan = setup.value?.grant.kind === 'bundle' ? setup.value.grant.plan : null
  return plan && PLAN_NAMES.has(plan) ? t(`billing.plan_${plan}`) : null
})

// ── Forms ──
const formsReason = computed(() => step('forms').reason)
async function turnOn() {
  const ok = await run('bind', async () => {
    await unskip('forms')
    await post('/site-binding')
  })
  if (ok && step('forms').state === 'done') {
    justBound.value = true
    goNext('forms')
  }
}

// ── Comments ──
const preview = ref<{ total: number | null, rows: Array<{ author: string, excerpt: string }> } | null>(null)
watch(() => open.value && screen.value === 'comments' && step('comments').reason !== 'imported', async (load) => {
  if (!load || preview.value) return
  try {
    preview.value = await $fetch(`${props.base}/comments-preview`)
  }
  catch {
    preview.value = { total: null, rows: [] }
  }
}, { immediate: true })
const commentsTotal = computed(() => preview.value?.total ?? props.state.summary?.comments?.total ?? 0)
const commentsReason = computed(() => step('comments').reason)
/** Ready to import: asked for, or skipped while the export is still there. */
const commentsReady = computed(() => commentsReason.value === 'ready' || (commentsReason.value === 'skipped' && commentsTotal.value > 0))
const COMMENTS_DONE = {
  imported: { title: 'migration_setup.comments_imported_title', body: 'migration_setup.comments_imported_body' },
  expired: { title: 'migration_setup.comments_expired_title', body: 'migration_setup.comments_expired_body' },
  none: { title: 'migration_setup.comments_none_title', body: 'migration_setup.comments_none_body' },
}
const commentsDone = computed(() => COMMENTS_DONE[(commentsReason.value in COMMENTS_DONE ? commentsReason.value : 'none') as keyof typeof COMMENTS_DONE])
async function importComments() {
  if (await run('import', async () => {
    await unskip('comments')
    await post('/import-comments')
  })) goNext('comments')
}

// ── Live site ──
const liveUrl = ref('')
watch(() => setup.value?.liveSiteUrl, (value) => {
  if (value && !liveUrl.value) liveUrl.value = value
}, { immediate: true })
const liveReason = computed(() => step('live').reason)
const liveCheck = computed(() => setup.value?.liveCheck ?? null)
/** "Not seen yet" after a look, and the reason the owner gave it. */
const notSeen = ref(false)
const didNotShow = ref(false)
const checkFileUrl = computed(() => {
  try {
    const url = new URL(liveUrl.value.trim())
    return `${url.origin}${url.pathname.replace(/\/+$/, '')}/.well-known/contentrain-check.txt`
  }
  catch {
    return null
  }
})

async function saveLiveUrl() {
  const value = liveUrl.value.trim()
  if (value && value !== setup.value?.liveSiteUrl) await post('/setup', { liveSiteUrl: value })
}
async function makeTestChange() {
  notSeen.value = false
  await run('test', async () => {
    await unskip('live')
    await saveLiveUrl()
    await post('/live-check')
  })
}
async function finish() {
  notSeen.value = false
  const ok = await run('verify', async () => {
    await saveLiveUrl()
    const result = await post('/live-check/verify') as { seen: boolean }
    notSeen.value = !result.seen
  })
  if (ok && step('live').state === 'done') open.value = false
}
async function seenByOwner() {
  if (await run('seen', () => post('/setup', { seen: true }))) open.value = false
}
function openDeployHooks() {
  open.value = false
  void router.replace({ query: { cdn: 'true' } })
}
</script>

<template>
  <DialogRoot v-model:open="open">
    <DialogPortal>
      <DialogOverlay class="fixed inset-0 z-50 bg-black/50 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=closed]:animate-out data-[state=closed]:fade-out-0" />
      <DialogContent
        class="fixed left-1/2 top-1/2 z-50 flex max-h-[90vh] w-full max-w-[40rem] -translate-x-1/2 -translate-y-1/2 flex-col rounded-2xl border border-secondary-200 bg-white shadow-xl max-sm:inset-0 max-sm:max-h-none max-sm:max-w-none max-sm:translate-x-0 max-sm:translate-y-0 max-sm:rounded-none dark:border-secondary-800 dark:bg-secondary-950"
        data-testid="migration-setup-wizard"
        :data-screen="screen"
        @interact-outside.prevent
      >
        <!-- Header -->
        <div class="flex shrink-0 items-center justify-between gap-3 border-b border-secondary-200 px-6 py-4 dark:border-secondary-800">
          <div class="min-w-0">
            <p class="text-xs font-semibold uppercase tracking-wider text-primary-600 dark:text-primary-400">
              {{ t('migration_setup.eyebrow') }}
            </p>
            <DialogTitle class="truncate text-base font-semibold text-heading dark:text-secondary-100">
              {{ t('migration_setup.title', { site: siteName }) }}
            </DialogTitle>
            <DialogDescription class="sr-only">
              {{ t('migration_setup.description') }}
            </DialogDescription>
          </div>
          <DialogClose
            class="flex size-9 shrink-0 items-center justify-center rounded-lg text-muted transition-colors hover:bg-secondary-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50 dark:hover:bg-secondary-900"
            :aria-label="t('migration_setup.close')"
          >
            <span class="icon-[annon--cross] size-4" aria-hidden="true" />
          </DialogClose>
        </div>

        <!-- Stepper -->
        <ol class="grid shrink-0 grid-cols-5 gap-2 border-b border-secondary-200 px-6 py-4 dark:border-secondary-800" data-testid="setup-stepper">
          <li v-for="item in stepper" :key="item.key">
            <button
              type="button"
              class="flex w-full flex-col gap-1.5 rounded text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50"
              :aria-current="screen === item.key ? 'step' : undefined"
              @click="screen = item.key"
            >
              <span
                class="h-1 w-full rounded-full"
                :class="screen === item.key ? 'bg-primary-600 dark:bg-primary-500' : item.state === 'done' ? 'bg-success-600 dark:bg-success-500' : 'bg-secondary-200 dark:bg-secondary-800'"
              />
              <span
                class="flex items-center gap-1 text-xs max-sm:sr-only"
                :class="screen === item.key ? 'font-semibold text-heading dark:text-secondary-100' : item.state === 'done' ? 'text-success-700 dark:text-success-400' : 'text-muted'"
              >
                {{ item.n }} {{ item.label }}
                <span v-if="item.state === 'done'" class="icon-[annon--check] size-3 shrink-0" :aria-label="t('migration_setup.step_done')" />
                <span v-else-if="item.state === 'skipped'" class="text-muted">· {{ t('migration_setup.step_skipped') }}</span>
              </span>
            </button>
          </li>
        </ol>
        <p class="px-6 pt-3 text-xs text-muted sm:hidden">
          {{ t('migration_setup.step_of', { n: stepper.find(s => s.key === screen)?.n ?? 1, label: stepper.find(s => s.key === screen)?.label ?? '' }) }}
        </p>

        <!-- 4: Images (own component: the move runs while the window is closed) -->
        <OrganismsMigrationSetupImages
          v-if="screen === 'images'"
          :key="`images-${setup?.media.jobId ?? ''}`"
          :base="base"
          :step="step('images')"
          :job-id="setup?.media.jobId ?? null"
          :refused-too-large="setup?.media.refusedTooLarge ?? null"
          :reload="reload"
          @back="goBack('images')"
          @next="goNext('images')"
          @skip="skip('images')"
        />

        <template v-else>
          <div class="min-h-0 flex-1 space-y-4 overflow-y-auto px-6 py-6">
            <!-- 1: Your site is in Studio -->
            <template v-if="screen === 'main'">
              <div class="space-y-2">
                <AtomsHeadingText :level="3" size="xl" weight="bold">
                  {{ t('migration_setup.main_title') }}
                </AtomsHeadingText>
                <p class="text-sm leading-relaxed text-body dark:text-secondary-300">
                  {{ t('migration_setup.main_body', { site: siteName }) }}
                </p>
              </div>
              <ul class="divide-y divide-secondary-200 rounded-xl border border-secondary-200 dark:divide-secondary-800 dark:border-secondary-800">
                <li v-if="repoFullName" class="flex items-start gap-3 px-4 py-3">
                  <span class="icon-[annon--check-circle] mt-0.5 size-4 shrink-0 text-success-600 dark:text-success-400" aria-hidden="true" />
                  <div class="min-w-0 flex-1">
                    <p class="text-sm font-medium text-heading dark:text-secondary-100">
                      {{ t('migration_setup.main_repo') }}
                    </p>
                    <p class="truncate text-xs text-muted">
                      {{ repoFullName }}
                    </p>
                  </div>
                  <a :href="`https://github.com/${repoFullName}`" target="_blank" rel="noopener" class="shrink-0 rounded text-xs font-medium text-primary-600 hover:text-primary-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50 dark:text-primary-400">
                    {{ t('migration_setup.main_open_github') }}
                  </a>
                </li>
                <li v-if="planName" class="flex items-start gap-3 px-4 py-3">
                  <span class="icon-[annon--check-circle] mt-0.5 size-4 shrink-0 text-success-600 dark:text-success-400" aria-hidden="true" />
                  <div class="min-w-0 flex-1">
                    <p class="text-sm font-medium text-heading dark:text-secondary-100">
                      {{ t('migration_setup.main_plan', { plan: planName }) }}
                    </p>
                    <p class="text-xs text-muted">
                      {{ t('migration_setup.main_plan_note') }}
                    </p>
                  </div>
                </li>
                <li v-if="contentLine" class="flex items-start gap-3 px-4 py-3">
                  <span class="icon-[annon--check-circle] mt-0.5 size-4 shrink-0 text-success-600 dark:text-success-400" aria-hidden="true" />
                  <div class="min-w-0 flex-1">
                    <p class="text-sm font-medium text-heading dark:text-secondary-100">
                      {{ t('migration_setup.main_content') }}
                    </p>
                    <p class="text-xs text-muted">
                      {{ contentLine }}
                    </p>
                  </div>
                </li>
              </ul>
            </template>

            <!-- 2: Forms and comments -->
            <template v-else-if="screen === 'forms'">
              <template v-if="step('forms').state === 'done'">
                <div class="space-y-2">
                  <AtomsHeadingText :level="3" size="xl" weight="bold">
                    {{ t('migration_setup.forms_done_title') }}
                  </AtomsHeadingText>
                  <p class="text-sm leading-relaxed text-body dark:text-secondary-300">
                    {{ t('migration_setup.forms_done_body') }}
                  </p>
                </div>
                <p v-if="formsReason === 'over_limit' && setup?.forms.overLimit" class="rounded-lg border border-warning-200 bg-warning-50 px-3 py-2 text-xs text-body dark:border-warning-800 dark:bg-warning-900/20 dark:text-secondary-300">
                  {{ t('migration_setup.forms_over_limit', { count: setup.forms.overLimit }) }}
                </p>
              </template>
              <template v-else>
                <div class="space-y-2">
                  <AtomsHeadingText :level="3" size="xl" weight="bold">
                    {{ t('migration_setup.forms_title') }}
                  </AtomsHeadingText>
                  <p class="text-sm leading-relaxed text-body dark:text-secondary-300">
                    {{ t('migration_setup.forms_body') }}
                  </p>
                </div>
                <div v-if="formsReason === 'pull_request'" class="space-y-2 rounded-xl border border-secondary-200 px-4 py-3.5 dark:border-secondary-800">
                  <p class="text-sm text-body dark:text-secondary-300">
                    {{ t('migration_setup.forms_pr') }}
                  </p>
                  <a v-if="step('forms').pullRequestUrl" :href="step('forms').pullRequestUrl!" target="_blank" rel="noopener" class="inline-flex rounded text-sm font-medium text-primary-600 hover:text-primary-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50 dark:text-primary-400">
                    {{ t('migration_setup.open_pull_request') }}
                  </a>
                </div>
                <p v-else-if="formsReason === 'conflict'" class="rounded-lg border border-warning-200 bg-warning-50 px-3 py-2 text-xs text-body dark:border-warning-800 dark:bg-warning-900/20 dark:text-secondary-300">
                  {{ t('migration_setup.forms_conflict') }}
                </p>
                <template v-else>
                  <div class="flex items-start gap-3 rounded-xl border border-secondary-200 px-4 py-3.5 dark:border-secondary-800">
                    <span class="icon-[annon--file-check] mt-0.5 size-4 shrink-0 text-primary-600 dark:text-primary-400" aria-hidden="true" />
                    <div class="space-y-1">
                      <p class="text-sm font-medium text-heading dark:text-secondary-100">
                        {{ t('migration_setup.forms_option') }}
                      </p>
                      <p class="text-xs text-muted">
                        {{ t('migration_setup.forms_option_note') }}
                      </p>
                    </div>
                  </div>
                  <p v-if="formsReason === 'failed'" class="rounded-lg border border-warning-200 bg-warning-50 px-3 py-2 text-xs text-body dark:border-warning-800 dark:bg-warning-900/20 dark:text-secondary-300">
                    {{ t('migration_setup.forms_failed') }}
                  </p>
                  <p v-if="reviewWorkflow || formsReason === 'review'" class="text-xs leading-relaxed text-muted">
                    {{ t('migration_setup.forms_review_note') }}
                  </p>
                </template>
              </template>
            </template>

            <!-- 3: Comments -->
            <template v-else-if="screen === 'comments'">
              <p v-if="justBound" class="flex items-center gap-2.5 rounded-lg bg-success-50 px-3.5 py-2.5 text-sm text-success-700 dark:bg-success-900/20 dark:text-success-300">
                <span class="icon-[annon--check] size-4 shrink-0" aria-hidden="true" />
                {{ t('migration_setup.comments_bound_banner') }}
              </p>
              <template v-if="commentsReady">
                <div class="space-y-2">
                  <AtomsHeadingText :level="3" size="xl" weight="bold">
                    {{ t('migration_setup.comments_title', { count: commentsTotal }) }}
                  </AtomsHeadingText>
                  <p class="text-sm leading-relaxed text-body dark:text-secondary-300">
                    {{ t('migration_setup.comments_body') }}
                  </p>
                </div>
                <ul v-if="preview?.rows.length" class="divide-y divide-secondary-200 rounded-xl border border-secondary-200 dark:divide-secondary-800 dark:border-secondary-800" data-testid="setup-comments-preview">
                  <li v-for="(row, i) in preview.rows" :key="i" class="space-y-0.5 px-4 py-3">
                    <p class="text-sm font-medium text-heading dark:text-secondary-100">
                      {{ row.author }}
                    </p>
                    <p class="text-xs text-body dark:text-secondary-300">
                      {{ row.excerpt }}
                    </p>
                  </li>
                  <li v-if="commentsTotal > preview.rows.length" class="px-4 py-2.5 text-xs text-muted">
                    {{ t('migration_setup.comments_more', { count: commentsTotal - preview.rows.length }) }}
                  </li>
                </ul>
              </template>
              <div v-else class="space-y-2">
                <AtomsHeadingText :level="3" size="xl" weight="bold">
                  {{ t(commentsDone.title) }}
                </AtomsHeadingText>
                <p class="text-sm leading-relaxed text-body dark:text-secondary-300">
                  {{ t(commentsDone.body, { count: state.commentsImported }) }}
                </p>
              </div>
            </template>

            <!-- 5: Live site -->
            <template v-else-if="screen === 'live'">
              <div class="space-y-2">
                <AtomsHeadingText :level="3" size="xl" weight="bold">
                  {{ liveReason === 'checked' ? t('migration_setup.live_done_title') : t('migration_setup.live_title') }}
                </AtomsHeadingText>
                <p class="text-sm leading-relaxed text-body dark:text-secondary-300">
                  {{ liveReason === 'checked' ? t('migration_setup.live_done_body') : t('migration_setup.live_body') }}
                </p>
              </div>
              <template v-if="liveReason !== 'checked'">
                <div class="space-y-1.5">
                  <AtomsFormLabel for="setup-live-url">
                    {{ t('migration_setup.live_url_label') }}
                  </AtomsFormLabel>
                  <AtomsFormInput id="setup-live-url" v-model="liveUrl" type="url" placeholder="https://" />
                </div>
                <ol class="list-decimal space-y-1.5 pl-5 text-sm text-body dark:text-secondary-300">
                  <li>{{ t('migration_setup.live_point_file') }}</li>
                  <li>{{ t('migration_setup.live_point_host') }}</li>
                  <li>{{ t('migration_setup.live_point_delete') }}</li>
                </ol>
                <div class="flex flex-wrap items-center gap-2">
                  <AtomsBaseButton type="button" variant="secondary" size="sm" :disabled="busy !== null || !checkFileUrl" @click="makeTestChange">
                    {{ busy === 'test' ? t('common.loading') : liveCheck ? t('migration_setup.live_test_again') : t('migration_setup.live_test') }}
                  </AtomsBaseButton>
                  <a v-if="checkFileUrl && liveCheck" :href="checkFileUrl" target="_blank" rel="noopener" class="inline-flex h-8 items-center gap-1.5 rounded-lg px-3 text-sm font-medium text-primary-600 hover:text-primary-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50 dark:text-primary-400">
                    {{ t('migration_setup.live_open') }}
                    <span class="icon-[annon--external-link] size-3.5" aria-hidden="true" />
                  </a>
                </div>
                <p v-if="liveCheck && liveReason === 'not_seen'" class="text-xs text-muted" data-testid="setup-live-status">
                  {{ t('migration_setup.live_status_merged') }}
                </p>
                <div v-else-if="liveReason === 'pull_request' || liveReason === 'review'" class="space-y-1 text-xs text-muted" data-testid="setup-live-status">
                  <p>{{ liveReason === 'pull_request' ? t('migration_setup.live_status_pr') : t('migration_setup.live_status_review') }}</p>
                  <a v-if="step('live').pullRequestUrl" :href="step('live').pullRequestUrl!" target="_blank" rel="noopener" class="inline-flex rounded font-medium text-primary-600 hover:text-primary-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50 dark:text-primary-400">
                    {{ t('migration_setup.open_pull_request') }}
                  </a>
                </div>
                <div v-if="notSeen" class="space-y-2 rounded-lg border border-warning-200 bg-warning-50 px-3.5 py-3 dark:border-warning-800 dark:bg-warning-900/20" data-testid="setup-live-not-seen">
                  <p class="text-xs text-body dark:text-secondary-300">
                    {{ t('migration_setup.live_not_seen') }}
                  </p>
                  <button type="button" class="rounded text-xs font-medium text-primary-600 hover:text-primary-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50 dark:text-primary-400" :disabled="busy !== null" @click="seenByOwner">
                    {{ t('migration_setup.live_seen_manual') }}
                  </button>
                </div>
                <p v-if="didNotShow" class="rounded-lg border border-secondary-200 px-3.5 py-3 text-xs leading-relaxed text-body dark:border-secondary-800 dark:text-secondary-300" data-testid="setup-live-help">
                  {{ t('migration_setup.live_help') }}
                </p>
                <p class="text-xs text-muted">
                  {{ t('migration_setup.live_deploy_hook') }}
                  <button type="button" class="rounded font-medium text-primary-600 hover:text-primary-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50 dark:text-primary-400" @click="openDeployHooks">
                    {{ t('migration_setup.live_deploy_hook_add') }}
                  </button>
                </p>
              </template>
            </template>

            <p v-if="error" class="text-xs text-danger-600 dark:text-danger-400" role="alert">
              {{ error }}
            </p>
          </div>

          <!-- Footer: one primary click per screen -->
          <div class="flex shrink-0 flex-wrap items-center gap-2 border-t border-secondary-200 px-6 py-4 max-sm:flex-col-reverse max-sm:items-stretch dark:border-secondary-800">
            <template v-if="screen === 'main'">
              <DialogClose as-child>
                <AtomsBaseButton type="button">
                  {{ t('migration_setup.later') }}
                </AtomsBaseButton>
              </DialogClose>
              <AtomsBaseButton type="button" variant="primary" class="ml-auto max-sm:ml-0" @click="goNext('main')">
                {{ t('migration_setup.start') }}
              </AtomsBaseButton>
            </template>

            <template v-else-if="current">
              <AtomsBaseButton type="button" @click="goBack(current.step)">
                {{ t('migration_setup.back') }}
              </AtomsBaseButton>
              <div class="ml-auto flex flex-wrap items-center justify-end gap-2 max-sm:ml-0 max-sm:flex-col-reverse max-sm:items-stretch">
                <!-- Forms -->
                <template v-if="screen === 'forms'">
                  <template v-if="(step('forms').state === 'needs_you' && formsReason !== 'conflict') || step('forms').state === 'skipped'">
                    <AtomsBaseButton v-if="step('forms').state !== 'skipped'" type="button" variant="secondary" :disabled="busy !== null" @click="skip('forms')">
                      {{ t('migration_setup.forms_skip') }}
                    </AtomsBaseButton>
                    <AtomsBaseButton type="button" variant="primary" :disabled="busy !== null" @click="turnOn">
                      {{ busy === 'bind' ? t('common.loading') : t('migration_setup.forms_turn_on') }}
                    </AtomsBaseButton>
                  </template>
                  <AtomsBaseButton v-else type="button" variant="primary" @click="goNext('forms')">
                    {{ t('migration_setup.continue') }}
                  </AtomsBaseButton>
                </template>

                <!-- Comments -->
                <template v-else-if="screen === 'comments'">
                  <template v-if="commentsReady">
                    <AtomsBaseButton v-if="step('comments').state !== 'skipped'" type="button" variant="secondary" :disabled="busy !== null" @click="skip('comments')">
                      {{ t('migration_setup.skip') }}
                    </AtomsBaseButton>
                    <AtomsBaseButton type="button" variant="primary" :disabled="busy !== null" @click="importComments">
                      {{ busy === 'import' ? t('common.loading') : t('migration_setup.comments_import', { count: commentsTotal }) }}
                    </AtomsBaseButton>
                  </template>
                  <AtomsBaseButton v-else type="button" variant="primary" @click="goNext('comments')">
                    {{ t('migration_setup.continue') }}
                  </AtomsBaseButton>
                </template>

                <!-- Live site -->
                <template v-else-if="screen === 'live'">
                  <template v-if="liveReason !== 'checked'">
                    <AtomsBaseButton v-if="step('live').state !== 'skipped'" type="button" variant="secondary" :disabled="busy !== null" @click="skip('live')">
                      {{ t('migration_setup.live_no_host') }}
                    </AtomsBaseButton>
                    <AtomsBaseButton v-if="liveCheck" type="button" variant="secondary" :disabled="busy !== null" @click="didNotShow = true">
                      {{ t('migration_setup.live_did_not_show') }}
                    </AtomsBaseButton>
                    <AtomsBaseButton type="button" variant="primary" :disabled="busy !== null || !liveCheck || liveCheck.status === 'pending_review'" @click="finish">
                      {{ busy === 'verify' ? t('common.loading') : t('migration_setup.live_finish') }}
                    </AtomsBaseButton>
                  </template>
                  <AtomsBaseButton v-else type="button" variant="primary" @click="open = false">
                    {{ t('migration_setup.done') }}
                  </AtomsBaseButton>
                </template>
              </div>
            </template>
          </div>
        </template>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>

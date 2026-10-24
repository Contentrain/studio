<script setup lang="ts">
/**
 * A migrated project's setup on the overview: one line saying where it stands, and the setup wizard behind it.
 *
 * The wizard opens itself for an owner or admin while the setup is not over, unless this browser closed it for the
 * project; "Continue setup" opens it at the first step still open, "Setup details" at the start, with every step
 * (skipped ones too) one click away. `?setup=<step>` (the claim screen's way here) opens it at that step.
 * A "needs you" line shows only when something is left: files the plan refused, which still load from WordPress.
 */
import type { MigrationSetupScreen, MigrationSetupStepName } from '~/composables/useMigrationSetup'

const props = defineProps<{
  workspaceId: string
  projectId: string
  /** The project's models and their entry counts, for the first screen's content line. */
  models: ReadonlyArray<{ readonly id: string, readonly name: string }>
  content: Readonly<Record<string, { readonly count: number }>>
  reviewWorkflow?: boolean
}>()

const { t } = useContent()
const route = useRoute()
const router = useRouter()
const { isOwnerOrAdmin } = useWorkspaceRole()
const { projects } = useProjects()
const { state, setup, step, firstOpen, base, load } = useMigrationSetup(toRef(props, 'workspaceId'), toRef(props, 'projectId'))

const open = ref(false)
const screen = ref<MigrationSetupScreen>('main')
const repoFullName = computed(() => projects.value.find(p => p.id === props.projectId)?.repo_full_name ?? null)

const closedKey = () => `contentrain-setup-closed:${props.projectId}`
function closedHere(): boolean {
  try {
    return localStorage.getItem(closedKey()) === '1'
  }
  catch {
    return false
  }
}
function rememberClosed() {
  try {
    localStorage.setItem(closedKey(), '1')
  }
  catch { /* the wizard opens again next time; nothing is lost */ }
}

const STEP_QUERY = new Set<string>(['forms', 'comments', 'images', 'live'])
let autoOpened = false
// The role can arrive after the setup (the workspace list loads behind a cached snapshot): decide once both are in.
watch([setup, isOwnerOrAdmin], ([value, canSetUp]) => {
  if (!value || autoOpened || !canSetUp) return
  autoOpened = true
  const asked = typeof route.query.setup === 'string' && STEP_QUERY.has(route.query.setup) ? route.query.setup as MigrationSetupStepName : null
  if (asked) {
    const { setup: _setup, ...query } = route.query
    void router.replace({ query })
    openAt(asked)
  }
  else if (!value.completedAt && !closedHere()) {
    openAt('main')
  }
})

function openAt(at: MigrationSetupScreen) {
  screen.value = at
  open.value = true
}

watch(open, (isOpen, wasOpen) => {
  if (wasOpen && !isOpen) {
    rememberClosed()
    void load()
  }
})

/** The images in Studio Media once the move landed: the import job's count, read once. */
const imagesMoved = ref<number | null>(null)
watch(() => step('images')?.reason === 'moved' ? setup.value?.media.jobId : null, async (jobId) => {
  imagesMoved.value = null
  if (!jobId) return
  try {
    const { job } = await $fetch<{ job: { done: number } }>(`${base()}/media/jobs/${jobId}`)
    imagesMoved.value = job.done
  }
  catch { /* the line goes without the count */ }
}, { immediate: true })

const facts = computed(() => {
  if (!setup.value) return []
  const lines: string[] = []
  const forms = step('forms')
  if (forms?.state === 'done') lines.push(t('migration_setup.summary_forms_on'))
  if (state.value?.commentsImported) lines.push(t('migration_setup.summary_comments', { count: state.value.commentsImported }))
  if (step('images')?.reason === 'moved')
    lines.push(imagesMoved.value ? t('migration_setup.summary_images', { count: imagesMoved.value }) : t('migration_setup.summary_images_moved'))
  if (step('live')?.reason === 'checked') lines.push(t('migration_setup.summary_live_checked'))
  return lines
})
const stepsLeft = computed(() => setup.value?.steps.filter(s => s.state === 'needs_you' || s.state === 'waiting').length ?? 0)
const refused = computed(() => setup.value?.media.refusedTooLarge ?? 0)
</script>

<template>
  <section
    v-if="setup"
    class="mx-5 mt-5 rounded-xl border border-secondary-200 bg-secondary-50 p-4 dark:border-secondary-800 dark:bg-secondary-900"
    data-testid="migration-setup-summary"
  >
    <div class="flex flex-wrap items-center gap-3">
      <div class="flex size-8 shrink-0 items-center justify-center rounded-lg bg-info-50 dark:bg-info-900/20">
        <span class="icon-[annon--import] size-4 text-info-600 dark:text-info-400" aria-hidden="true" />
      </div>
      <div class="min-w-0 flex-1">
        <h4 class="text-sm font-semibold text-heading dark:text-secondary-100">
          {{ setup.completedAt ? t('migration_setup.summary_title_done') : t('migration_setup.summary_title_open', { count: stepsLeft }) }}
        </h4>
        <p v-if="facts.length" class="mt-0.5 text-xs text-muted">
          {{ facts.join(' · ') }}
        </p>
      </div>
      <div v-if="isOwnerOrAdmin" class="flex shrink-0 gap-2">
        <AtomsBaseButton type="button" size="sm" @click="openAt('main')">
          {{ t('migration_setup.summary_details') }}
        </AtomsBaseButton>
        <AtomsBaseButton v-if="!setup.completedAt" type="button" variant="primary" size="sm" @click="openAt(firstOpen)">
          {{ t('migration_setup.summary_continue') }}
        </AtomsBaseButton>
      </div>
    </div>

    <div v-if="refused" class="mt-3 flex items-start gap-2 rounded-lg border border-warning-200 bg-warning-50 px-3 py-2 dark:border-warning-800 dark:bg-warning-900/20" data-testid="migration-setup-refused">
      <span class="icon-[annon--alert-triangle] mt-0.5 size-3.5 shrink-0 text-warning-600 dark:text-warning-400" aria-hidden="true" />
      <p class="text-xs text-body dark:text-secondary-300">
        <span class="font-medium text-heading dark:text-secondary-100">{{ t('migration_setup.summary_refused_title', { count: refused }) }}</span>
        {{ t('migration_setup.summary_refused_body') }}
      </p>
    </div>

    <OrganismsMigrationSetupWizard
      v-if="state && isOwnerOrAdmin"
      v-model:open="open"
      v-model:screen="screen"
      :state="state"
      :base="base()"
      :repo-full-name="repoFullName"
      :models="models"
      :content="content"
      :review-workflow="reviewWorkflow"
      :reload="load"
    />
  </section>
</template>

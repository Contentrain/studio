<script setup lang="ts">
/**
 * Studio included with a Contentrain Migrate order — /migrate/claim.
 *
 * Migrate's delivery step links here with a signed claim token
 * (`?token=…`). Signing in is handled by the global auth middleware, which
 * brings the visitor back to this URL. The token is exchanged for a grant
 * on the signed-in account, and the URL is rewritten to `?grant=<id>` so a
 * reload (or the way back from an abandoned checkout) does not replay an
 * expired token.
 *
 * The visitor picks a workspace they own or administer that has no running
 * subscription; the provider checkout then starts the grant's trial at $0
 * today, and the plan's regular price applies after it unless canceled.
 *
 * Once the grant's trial has started, the screen is also the way back to
 * the delivered site: its project once the repo is connected there (straight
 * to the migration's media with `?focus=media`, Migrate's "move the media to
 * Studio"), the workspace until then.
 */
import { PLAN_PRICING } from '~~/shared/utils/license'

definePageMeta({
  layout: false,
})

interface GrantView {
  id: string
  plan: 'starter' | 'pro'
  trialDays: number
  repo: { owner: string, name: string }
  email: string
  workspaceId: string | null
  state: 'claimed' | 'bound' | 'redeemed'
}
interface Destination { workspaceSlug: string, projectId: string | null }

const { t } = useContent()
const route = useRoute()
const router = useRouter()
const { workspaces, fetchWorkspaces } = useWorkspaces()

useHead({ title: () => t('migrate_claim.title') })

const grant = ref<GrantView | null>(null)
const destination = ref<Destination | null>(null)
/** Migrate's "move the media to Studio" opens the migration's media card. */
const focusMedia = route.query.focus === 'media'
/** Why this plan — only present when opened from the claim link. */
const planEvidence = ref<Array<{ limit_key: string, measured: number, limit: number, capability?: string }>>([])
const loadError = ref('')
const submitting = ref(false)
const submitError = ref('')
const selectedWorkspaceId = ref<string | null>(null)

const planPricing = computed(() => (grant.value ? PLAN_PRICING[grant.value.plan] : null))
const projectPath = computed(() => {
  const d = destination.value
  if (!d?.projectId) return null
  return `/w/${d.workspaceSlug}/projects/${d.projectId}${focusMedia ? '?focus=migration-media' : ''}`
})

type WorkspaceItem = (typeof workspaces.value)[number]

/** A running subscription blocks a second one (the server refuses it too). */
function hasRunningSubscription(workspace: WorkspaceItem): boolean {
  const account = workspace.payment_account
  if (!account?.subscription_id) return false
  return !['canceled', 'incomplete_expired'].includes(account.subscription_status ?? '')
}

interface WorkspaceOption { workspace: WorkspaceItem, eligible: boolean, reason: string | null }

const options = computed<WorkspaceOption[]>(() => workspaces.value.map((workspace) => {
  const role = workspace.workspace_members?.[0]?.role
  if (role !== 'owner' && role !== 'admin') return { workspace, eligible: false, reason: t('migrate_claim.ineligible_role') }
  if (grant.value?.workspaceId && grant.value.workspaceId !== workspace.id) return { workspace, eligible: false, reason: t('migrate_claim.ineligible_bound') }
  if (hasRunningSubscription(workspace)) return { workspace, eligible: false, reason: t('migrate_claim.ineligible_subscribed') }
  return { workspace, eligible: true, reason: null }
}))

const trialEndText = computed(() => {
  if (!grant.value) return ''
  const end = new Date(Date.now() + grant.value.trialDays * 24 * 60 * 60 * 1000)
  return end.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
})

onMounted(async () => {
  const token = typeof route.query.token === 'string' ? route.query.token : null
  const grantId = typeof route.query.grant === 'string' ? route.query.grant : null
  try {
    const [result] = await Promise.all([
      token
        ? $fetch<{ grant: GrantView, destination?: Destination | null, planEvidence?: typeof planEvidence.value }>('/api/migrate/claim', { method: 'POST', body: { token } })
        : grantId
          ? $fetch<{ grant: GrantView, destination?: Destination | null }>(`/api/migrate/grants/${encodeURIComponent(grantId)}`)
          : Promise.reject(new Error('missing')),
      fetchWorkspaces(),
    ])
    grant.value = result.grant
    destination.value = result.destination ?? null
    planEvidence.value = ('planEvidence' in result && Array.isArray(result.planEvidence)) ? result.planEvidence : []
    if (token) await router.replace({ query: { grant: result.grant.id, ...(focusMedia ? { focus: 'media' } : {}) } })

    const eligible = options.value.filter(o => o.eligible)
    if (grant.value.workspaceId) selectedWorkspaceId.value = grant.value.workspaceId
    else if (eligible.length === 1) selectedWorkspaceId.value = eligible[0]!.workspace.id
  }
  catch (e: unknown) {
    loadError.value = resolveApiError(e, t('migrate_claim.load_failed'))
  }
})

async function startTrial() {
  if (!grant.value || !selectedWorkspaceId.value) return
  submitting.value = true
  submitError.value = ''
  try {
    const result = await $fetch<{ url: string }>(`/api/migrate/grants/${grant.value.id}/checkout`, {
      method: 'POST',
      body: { workspaceId: selectedWorkspaceId.value },
    })
    // The provider's hosted checkout is another origin.
    window.location.href = result.url
  }
  catch (e: unknown) {
    submitError.value = resolveApiError(e, t('migrate_claim.checkout_failed'))
    submitting.value = false
  }
}
</script>

<template>
  <div class="flex min-h-screen items-center justify-center bg-secondary-50 px-4 py-10 dark:bg-secondary-950">
    <div class="w-full max-w-lg">
      <div v-if="loadError" class="rounded-xl border border-border bg-white p-8 text-center dark:border-secondary-800 dark:bg-secondary-900">
        <p class="text-sm text-danger-600 dark:text-danger-400">
          {{ loadError }}
        </p>
      </div>

      <div v-else-if="!grant || !planPricing" class="flex justify-center py-16">
        <AtomsSpinner :label="t('migrate_claim.loading')" />
      </div>

      <div v-else class="rounded-xl border border-border bg-white p-8 dark:border-secondary-800 dark:bg-secondary-900">
        <p class="text-xs font-semibold tracking-widest text-primary-700 uppercase dark:text-primary-300">
          {{ t('migrate_claim.kicker') }}
        </p>
        <AtomsHeadingText tag="h1" size="lg" class="mt-2">
          {{ t('migrate_claim.heading', { days: grant.trialDays, plan: planPricing.name }) }}
        </AtomsHeadingText>
        <p class="mt-2 text-sm text-body dark:text-secondary-300">
          {{ t('migrate_claim.repo_line', { repo: `${grant.repo.owner}/${grant.repo.name}` }) }}
        </p>
        <ul v-if="planEvidence.length" class="mt-3 space-y-1" :aria-label="t('migrate_claim.plan_reason_label', { plan: planPricing.name })">
          <li v-for="item in planEvidence" :key="item.limit_key" class="flex gap-2 text-xs text-body dark:text-secondary-300">
            <span class="icon-[annon--info] mt-0.5 size-3.5 shrink-0 text-info-500" aria-hidden="true" />
            {{ t('migrate_claim.plan_reason', { what: item.capability ?? item.limit_key, measured: item.measured.toLocaleString('en-US'), limit: item.limit.toLocaleString('en-US') }) }}
          </li>
        </ul>

        <div v-if="destination && grant.state === 'redeemed'" class="mt-6 flex flex-wrap items-center gap-3" data-testid="claim-destination">
          <AtomsBaseButton v-if="projectPath" variant="primary" data-testid="claim-open-project" @click="navigateTo(projectPath)">
            {{ focusMedia ? t('migrate_claim.open_media') : t('migrate_claim.open_project') }}
          </AtomsBaseButton>
          <template v-else>
            <p class="text-sm text-body dark:text-secondary-300">
              {{ t('migrate_claim.connect_repo', { repo: `${grant.repo.owner}/${grant.repo.name}` }) }}
            </p>
            <AtomsBaseButton variant="secondary" @click="navigateTo(`/w/${destination.workspaceSlug}`)">
              {{ t('migrate_claim.open_workspace') }}
            </AtomsBaseButton>
          </template>
        </div>

        <div v-if="grant.state === 'redeemed'" class="mt-6 rounded-lg bg-secondary-50 px-4 py-3 text-sm text-body dark:bg-secondary-800 dark:text-secondary-300">
          {{ t('migrate_claim.already_used') }}
        </div>

        <template v-else>
          <!-- What is bought, stated before the provider's checkout. -->
          <dl class="mt-6 space-y-2 rounded-lg border border-border px-4 py-3 text-sm dark:border-secondary-800">
            <div class="flex justify-between gap-4">
              <dt class="text-label">
                {{ t('migrate_claim.due_today') }}
              </dt>
              <dd class="font-semibold text-heading dark:text-secondary-100">
                $0.00
              </dd>
            </div>
            <div class="flex justify-between gap-4">
              <dt class="text-label">
                {{ t('migrate_claim.then') }}
              </dt>
              <dd class="text-right text-heading dark:text-secondary-100">
                {{ t('migrate_claim.then_price', { price: `$${planPricing.priceMonthly}`, date: trialEndText }) }}
              </dd>
            </div>
          </dl>
          <p class="mt-2 text-xs text-muted">
            {{ t('migrate_claim.cancel_note') }}
          </p>

          <div class="mt-6">
            <AtomsSectionLabel :label="t('migrate_claim.select_workspace')" />
            <div class="mt-2 max-h-64 space-y-2 overflow-y-auto pr-1">
              <button
                v-for="option in options"
                :key="option.workspace.id"
                type="button"
                class="flex w-full items-center justify-between rounded-lg border px-3 py-2 text-left text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50"
                :class="[
                  option.eligible
                    ? (selectedWorkspaceId === option.workspace.id
                      ? 'border-primary-500 bg-primary-50 dark:bg-primary-900/20'
                      : 'border-secondary-200 hover:bg-secondary-50 dark:border-secondary-800 dark:hover:bg-secondary-800')
                    : 'cursor-not-allowed border-secondary-200 opacity-60 dark:border-secondary-800',
                ]"
                :disabled="!option.eligible"
                :aria-pressed="selectedWorkspaceId === option.workspace.id"
                @click="selectedWorkspaceId = option.workspace.id"
              >
                <span class="truncate font-medium text-heading dark:text-secondary-100">{{ option.workspace.name || option.workspace.slug }}</span>
                <span v-if="option.reason" class="ml-2 shrink-0 text-xs text-muted">{{ option.reason }}</span>
              </button>
            </div>
          </div>

          <p v-if="submitError" class="mt-4 text-sm text-danger-600 dark:text-danger-400" role="alert">
            {{ submitError }}
          </p>

          <AtomsBaseButton
            variant="primary"
            class="mt-6 w-full justify-center"
            :disabled="!selectedWorkspaceId || submitting"
            @click="startTrial"
          >
            {{ t('migrate_claim.start', { days: grant.trialDays }) }}
          </AtomsBaseButton>
        </template>
      </div>
    </div>
  </div>
</template>

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
 * A workspace that already pays for a plan covering the grant's is offered
 * too: the site is added to it, with no trial and no second subscription. A
 * plan below the grant's is shown with why, and a way to upgrade it.
 *
 * A bundle grant (Studio came with the order — paid with it, or covered by a
 * plan the account already had) has no trial to start: the same screen is the
 * way to the site and says how the workspace's plan stands. The site follows
 * that workspace's plan like any other project; when the plan has ended the
 * screen says so and points to billing.
 *
 * A claim error is never a dead end: each one gets a way on (open Studio, its
 * workspaces, or support), picked from the error's `code`.
 *
 * Once the grant's trial has started, the screen is also the way back to
 * the delivered site: its project once the repo is connected there (straight
 * to the migration's media with `?focus=media`, Migrate's "move the media to
 * Studio"), the workspace until then.
 */
import { ENTERPRISE_CONTACT_EMAIL, PLAN_PRICING } from '~~/shared/utils/license'
import { planCovers } from '~~/shared/utils/migrate-bundle'

definePageMeta({
  layout: false,
})

interface GrantView {
  id: string
  kind: 'trial' | 'bundle'
  plan: 'starter' | 'pro'
  /** Null for a bundle grant. */
  trialDays: number | null
  /** Null for a bundle grant until the delivery repository reaches Studio. */
  repo: { owner: string, name: string } | null
  email: string
  workspaceId: string | null
  state: 'claimed' | 'bound' | 'redeemed'
}
interface Destination { workspaceSlug: string, projectId: string | null }
/** How a bundle grant's workspace plan stands. */
interface BundleStatus { planState: 'active' | 'ending' | 'ended', workspaceSlug: string }
/** The site's comments export, taken onto the grant while the claim is made. */
interface ClaimComments { status: 'pending' | 'ready' | 'imported' | 'unavailable' | 'expired', count: number }

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
const comments = ref<ClaimComments | null>(null)
const bundle = ref<BundleStatus | null>(null)
const loadError = ref('')
/** The API's error `code` (separate per refusal), which picks the way on from a failed claim. */
const loadErrorCode = ref('')
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

interface WorkspaceOption { workspace: WorkspaceItem, eligible: boolean, reason: string | null, attach: boolean, billingIssue?: 'too_small' | 'past_due' | 'ending' }

/** The sold plan behind a workspace's running, paid subscription (Enterprise sits above both). */
function paidPlanOf(workspace: WorkspaceItem): 'starter' | 'pro' | null {
  const account = workspace.payment_account
  if (account?.subscription_status !== 'active') return null
  return account.plan === 'pro' || account.plan === 'enterprise' ? 'pro' : account.plan === 'starter' ? 'starter' : null
}

const options = computed<WorkspaceOption[]>(() => workspaces.value.map((workspace) => {
  const role = workspace.workspace_members?.[0]?.role
  if (role !== 'owner' && role !== 'admin') return { workspace, eligible: false, reason: t('migrate_claim.ineligible_role'), attach: false }
  if (grant.value?.workspaceId && grant.value.workspaceId !== workspace.id) return { workspace, eligible: false, reason: t('migrate_claim.ineligible_bound'), attach: false }
  if (hasRunningSubscription(workspace)) {
    const account = workspace.payment_account
    const needed = grant.value?.plan
    if (account?.subscription_status === 'past_due') return { workspace, eligible: false, reason: t('migrate_claim.ineligible_past_due'), attach: false, billingIssue: 'past_due' }
    if (account?.subscription_status === 'active' && account.cancel_at_period_end) return { workspace, eligible: false, reason: t('migrate_claim.ineligible_ending'), attach: false, billingIssue: 'ending' }
    const paid = paidPlanOf(workspace)
    if (paid && needed && planCovers(paid, needed)) return { workspace, eligible: true, reason: t('migrate_claim.attach_covers'), attach: true }
    if (paid && needed) return { workspace, eligible: false, reason: t('migrate_claim.ineligible_plan_below', { plan: PLAN_PRICING[needed].name }), attach: false, billingIssue: 'too_small' }
    return { workspace, eligible: false, reason: t('migrate_claim.ineligible_subscribed'), attach: false }
  }
  return { workspace, eligible: true, reason: null, attach: false }
}))

const selectedOption = computed(() => options.value.find(o => o.workspace.id === selectedWorkspaceId.value) ?? null)
/** Every workspace is taken or cannot take the site: the way on is fixing a plan in billing, not waiting. */
const billingTarget = computed(() => {
  if (options.value.some(o => o.eligible)) return null
  const option = options.value.find(o => o.billingIssue)
  return option?.billingIssue ? { workspace: option.workspace, issue: option.billingIssue } : null
})

const repoText = computed(() => (grant.value?.repo ? `${grant.value.repo.owner}/${grant.value.repo.name}` : ''))
const isBundle = computed(() => grant.value?.kind === 'bundle')
const billingPath = computed(() => (bundle.value ? `/w/${bundle.value.workspaceSlug}/settings?tab=billing` : null))
const supportHref = `mailto:${ENTERPRISE_CONTACT_EMAIL}?subject=${encodeURIComponent('Studio offer from Contentrain Migrate')}`
/** Whoever is on the other end of a refused claim: signed in with the wrong account, or a link that no longer works. */
const wrongAccount = computed(() => loadErrorCode.value === 'claim_taken')

const trialEndText = computed(() => {
  if (!grant.value?.trialDays) return ''
  const end = new Date(Date.now() + grant.value.trialDays * 24 * 60 * 60 * 1000)
  return end.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
})

onMounted(async () => {
  const token = typeof route.query.token === 'string' ? route.query.token : null
  const grantId = typeof route.query.grant === 'string' ? route.query.grant : null
  try {
    const [result] = await Promise.all([
      token
        ? $fetch<{ grant: GrantView, destination?: Destination | null, bundle?: BundleStatus | null, planEvidence?: typeof planEvidence.value, comments?: ClaimComments | null }>('/api/migrate/claim', { method: 'POST', body: { token } })
        : grantId
          ? $fetch<{ grant: GrantView, destination?: Destination | null, bundle?: BundleStatus | null, comments?: ClaimComments | null }>(`/api/migrate/grants/${encodeURIComponent(grantId)}`)
          : Promise.reject(new Error('missing')),
      fetchWorkspaces(),
    ])
    grant.value = result.grant
    destination.value = result.destination ?? null
    comments.value = result.comments ?? null
    bundle.value = result.bundle ?? null
    planEvidence.value = ('planEvidence' in result && Array.isArray(result.planEvidence)) ? result.planEvidence : []
    if (token) await router.replace({ query: { grant: result.grant.id, ...(focusMedia ? { focus: 'media' } : {}) } })

    const eligible = options.value.filter(o => o.eligible)
    if (grant.value.workspaceId) selectedWorkspaceId.value = grant.value.workspaceId
    else if (eligible.length === 1) selectedWorkspaceId.value = eligible[0]!.workspace.id
  }
  catch (e: unknown) {
    loadError.value = resolveApiError(e, t('migrate_claim.load_failed'))
    const code = (e as { data?: { data?: { code?: unknown } } })?.data?.data?.code
    loadErrorCode.value = typeof code === 'string' ? code : ''
  }
})

async function startTrial() {
  if (!grant.value || !selectedWorkspaceId.value) return
  submitting.value = true
  submitError.value = ''
  try {
    if (selectedOption.value?.attach) {
      await $fetch(`/api/migrate/grants/${grant.value.id}/attach`, { method: 'POST', body: { workspaceId: selectedWorkspaceId.value } })
      // The grant is used now: reload it so the screen shows the way to the site.
      const refreshed = await $fetch<{ grant: GrantView, destination?: Destination | null }>(`/api/migrate/grants/${encodeURIComponent(grant.value.id)}`)
      grant.value = refreshed.grant
      destination.value = refreshed.destination ?? null
      submitting.value = false
      return
    }
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
      <div v-if="loadError" class="rounded-xl border border-border bg-white p-8 text-center dark:border-secondary-800 dark:bg-secondary-900" data-testid="claim-error">
        <p class="text-sm text-danger-600 dark:text-danger-400" role="alert">
          {{ loadError }}
        </p>
        <p class="mt-3 text-sm text-body dark:text-secondary-300">
          {{ wrongAccount ? t('migrate_claim.error_next_account') : t('migrate_claim.error_next') }}
        </p>
        <div class="mt-5 flex flex-wrap items-center justify-center gap-3">
          <AtomsBaseButton variant="primary" data-testid="claim-error-open-studio" @click="navigateTo('/')">
            {{ t('migrate_claim.error_open_studio') }}
          </AtomsBaseButton>
          <a :href="supportHref" class="text-sm font-medium text-primary-700 underline dark:text-primary-300" data-testid="claim-error-support">
            {{ t('migrate_claim.error_support') }}
          </a>
        </div>
      </div>

      <div v-else-if="!grant || !planPricing" class="flex justify-center py-16">
        <AtomsSpinner :label="t('migrate_claim.loading')" />
      </div>

      <div v-else class="rounded-xl border border-border bg-white p-8 dark:border-secondary-800 dark:bg-secondary-900">
        <p class="text-xs font-semibold tracking-widest text-primary-700 uppercase dark:text-primary-300">
          {{ t('migrate_claim.kicker') }}
        </p>
        <AtomsHeadingText tag="h1" size="lg" class="mt-2">
          {{ isBundle ? t('migrate_claim.bundle_heading', { plan: planPricing.name }) : t('migrate_claim.heading', { days: grant.trialDays ?? 0, plan: planPricing.name }) }}
        </AtomsHeadingText>
        <p v-if="repoText" class="mt-2 text-sm text-body dark:text-secondary-300">
          {{ t('migrate_claim.repo_line', { repo: repoText }) }}
        </p>
        <ul v-if="planEvidence.length" class="mt-3 space-y-1" :aria-label="t('migrate_claim.plan_reason_label', { plan: planPricing.name })">
          <li v-for="item in planEvidence" :key="item.limit_key" class="flex gap-2 text-xs text-body dark:text-secondary-300">
            <span class="icon-[annon--info] mt-0.5 size-3.5 shrink-0 text-info-500" aria-hidden="true" />
            {{ t('migrate_claim.plan_reason', { what: item.capability ?? item.limit_key, measured: item.measured.toLocaleString('en-US'), limit: item.limit.toLocaleString('en-US') }) }}
          </li>
        </ul>

        <p v-if="comments" class="mt-3 flex gap-2 text-xs text-body dark:text-secondary-300" data-testid="claim-comments">
          <span class="icon-[annon--comments] mt-0.5 size-3.5 shrink-0 text-muted" aria-hidden="true" />
          {{ t(`migrate_claim.comments_${comments.status}`, { count: comments.count.toLocaleString('en-US') }) }}
        </p>

        <!-- A bundle grant: no trial to start, the way to the site and how the plan stands. -->
        <div v-if="isBundle" class="mt-6 space-y-4" data-testid="claim-bundle">
          <p
            v-if="bundle"
            class="rounded-lg px-4 py-3 text-sm"
            :class="bundle.planState === 'active' ? 'bg-secondary-50 text-body dark:bg-secondary-800 dark:text-secondary-300' : 'border border-warning-300 text-body dark:border-warning-700 dark:text-secondary-300'"
            :data-plan-state="bundle.planState"
            data-testid="claim-bundle-plan"
          >
            {{ t(`migrate_claim.bundle_plan_${bundle.planState}`, { plan: planPricing.name }) }}
          </p>
          <p v-else class="rounded-lg bg-secondary-50 px-4 py-3 text-sm text-body dark:bg-secondary-800 dark:text-secondary-300">
            {{ t('migrate_claim.bundle_plan_unknown', { plan: planPricing.name }) }}
          </p>
          <div class="flex flex-wrap items-center gap-3" data-testid="claim-destination">
            <AtomsBaseButton v-if="projectPath" :variant="bundle?.planState === 'ended' ? 'secondary' : 'primary'" data-testid="claim-open-project" @click="navigateTo(projectPath)">
              {{ focusMedia ? t('migrate_claim.open_media') : t('migrate_claim.open_project') }}
            </AtomsBaseButton>
            <AtomsBaseButton v-else-if="destination" :variant="bundle?.planState === 'ended' ? 'secondary' : 'primary'" data-testid="claim-open-workspace" @click="navigateTo(`/w/${destination.workspaceSlug}`)">
              {{ t('migrate_claim.open_workspace') }}
            </AtomsBaseButton>
            <AtomsBaseButton v-if="billingPath && bundle?.planState !== 'active'" variant="primary" data-testid="claim-bundle-billing" @click="navigateTo(billingPath)">
              {{ bundle?.planState === 'ended' ? t('migrate_claim.bundle_choose_plan') : t('migrate_claim.billing_link') }}
            </AtomsBaseButton>
            <AtomsBaseButton v-if="!destination" variant="primary" data-testid="claim-open-studio" @click="navigateTo('/')">
              {{ t('migrate_claim.error_open_studio') }}
            </AtomsBaseButton>
          </div>
          <p v-if="repoText && !projectPath && destination" class="text-sm text-body dark:text-secondary-300">
            {{ t('migrate_claim.connect_repo', { repo: repoText }) }}
          </p>
        </div>

        <div v-else-if="destination && grant.state === 'redeemed'" class="mt-6 flex flex-wrap items-center gap-3" data-testid="claim-destination">
          <AtomsBaseButton v-if="projectPath" variant="primary" data-testid="claim-open-project" @click="navigateTo(projectPath)">
            {{ focusMedia ? t('migrate_claim.open_media') : t('migrate_claim.open_project') }}
          </AtomsBaseButton>
          <template v-else>
            <p class="text-sm text-body dark:text-secondary-300">
              {{ t('migrate_claim.connect_repo', { repo: repoText }) }}
            </p>
            <AtomsBaseButton variant="secondary" @click="navigateTo(`/w/${destination.workspaceSlug}`)">
              {{ t('migrate_claim.open_workspace') }}
            </AtomsBaseButton>
          </template>
        </div>

        <div v-if="!isBundle && grant.state === 'redeemed'" class="mt-6 rounded-lg bg-secondary-50 px-4 py-3 text-sm text-body dark:bg-secondary-800 dark:text-secondary-300">
          {{ t('migrate_claim.already_used') }}
        </div>

        <template v-else-if="!isBundle">
          <!-- What is bought, stated before the provider's checkout. -->
          <p v-if="selectedOption?.attach" class="mt-6 rounded-lg border border-border px-4 py-3 text-sm text-body dark:border-secondary-800 dark:text-secondary-300" data-testid="claim-attach-note">
            {{ t('migrate_claim.attach_note') }}
          </p>
          <dl v-else class="mt-6 space-y-2 rounded-lg border border-border px-4 py-3 text-sm dark:border-secondary-800">
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
          <p v-if="!selectedOption?.attach" class="mt-2 text-xs text-muted">
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

          <p v-if="billingTarget" class="mt-3 text-sm text-body dark:text-secondary-300" data-testid="claim-upgrade">
            {{ t(`migrate_claim.billing_hint_${billingTarget.issue}`, { plan: PLAN_PRICING[grant.plan].name }) }}
            <NuxtLink :to="`/w/${billingTarget.workspace.slug}/settings?tab=billing`" class="font-medium text-primary-700 underline dark:text-primary-300">
              {{ t('migrate_claim.billing_link') }}
            </NuxtLink>
          </p>

          <p v-if="submitError" class="mt-4 text-sm text-danger-600 dark:text-danger-400" role="alert">
            {{ submitError }}
          </p>

          <AtomsBaseButton
            variant="primary"
            class="mt-6 w-full justify-center"
            :disabled="!selectedWorkspaceId || submitting"
            @click="startTrial"
          >
            {{ selectedOption?.attach ? t('migrate_claim.attach_button') : t('migrate_claim.start', { days: grant.trialDays ?? 0 }) }}
          </AtomsBaseButton>
        </template>
      </div>
    </div>
  </div>
</template>

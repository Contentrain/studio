<script setup lang="ts">
import { PLAN_PRICING } from '~~/shared/utils/license'
import { STUDIO_YEARLY_LIST_CENTS } from '~~/shared/utils/migrate-bundle'

const { t } = useContent()
const {
  billingState,
  effectivePlan,
  isTrialing,
  trialDaysLeft,
  cancelsAt,
  prepaidUntil,
  prepaidRenewalOpensAt,
  prepaidRenewalOpen,
  prepaidRenewalPlan,
  keepStudio,
  openPortal,
} = useBilling()
const deployment = useDeployment()
// Members see the plan and the usage; only owners and admins can act on them
// (checkout and portal answer 403 to anyone else).
const { isOwnerOrAdmin } = useWorkspaceRole()
const toast = useToast()

defineProps<{
  workspaceId: string
}>()

const planModalOpen = ref(false)
const loading = ref(false)
const keepingPlan = ref<'starter' | 'pro' | null>(null)

const longDate = (iso: string) => new Date(iso).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
const yearlyPrice = (plan: 'starter' | 'pro') => `$${STUDIO_YEARLY_LIST_CENTS[plan] / 100}`
const keepPlans = ['starter', 'pro'] as const
/** The plan Studio continues on after the prepaid year, when one is set. */
const renewalPlan = computed(() => {
  const plan = prepaidRenewalPlan.value
  return plan === 'starter' || plan === 'pro' ? plan : null
})

async function handleKeepStudio(plan: 'starter' | 'pro') {
  keepingPlan.value = plan
  try {
    await keepStudio(plan)
  }
  catch (err: unknown) {
    toast.error(resolveApiError(err, t('common.server_error')))
  }
  finally {
    keepingPlan.value = null
  }
}

const planName = computed(() => PLAN_PRICING[effectivePlan.value]?.name ?? 'Free')
const planPrice = computed(() => PLAN_PRICING[effectivePlan.value]?.priceMonthly ?? 0)

/**
 * Active subscription = Managed profile with a live subscription-
 * driven billing state. Community and operator-managed profiles
 * never surface subscription controls here.
 */
const hasSubscription = computed(() =>
  deployment.hasManagedBilling.value
  && ['subscribed', 'trial_active', 'past_due', 'canceled'].includes(billingState.value),
)

const stateLabel = computed(() => {
  switch (billingState.value) {
    case 'free': return t('billing.state_free')
    case 'trial_active': return t('billing.state_trialing')
    case 'subscribed':
    case 'prepaid': return t('billing.state_active')
    case 'past_due': return t('billing.state_past_due')
    case 'canceled': return t('billing.state_canceled')
    case 'trial_expired':
    case 'grace_expired':
    case 'canceled_expired': return t('billing.state_expired')
    default: return ''
  }
})

const stateBadgeVariant = computed(() => {
  switch (billingState.value) {
    case 'subscribed':
    case 'prepaid': return 'success' as const
    case 'trial_active': return 'primary' as const
    case 'past_due': return 'warning' as const
    case 'canceled':
    case 'trial_expired':
    case 'grace_expired':
    case 'canceled_expired': return 'danger' as const
    default: return 'secondary' as const
  }
})

/**
 * Non-managed surfaces render a single information card instead of
 * the subscription widget. Community explains the AGPL deployment;
 * on-premise explains that the operator controls the plan.
 */
const infoCard = computed(() => {
  if (deployment.isCommunity.value) {
    return {
      title: t('billing.community_title'),
      description: t('billing.community_description'),
      badge: t('billing.community_badge'),
    }
  }
  if (deployment.isOperatorManagedPlan.value) {
    return {
      title: t('billing.on_premise_title'),
      description: t('billing.on_premise_description'),
      badge: t('billing.on_premise_badge'),
    }
  }
  return null
})

async function handleManageSubscription() {
  loading.value = true
  try {
    await openPortal()
  }
  catch (err: unknown) {
    // The portal is the only way to change or keep the plan: say it failed.
    toast.error(resolveApiError(err, t('common.server_error')))
  }
  finally {
    loading.value = false
  }
}
</script>

<template>
  <div class="space-y-6">
    <!-- Community or on-premise notice (non-managed surfaces) -->
    <div
      v-if="infoCard"
      class="rounded-lg border border-secondary-200 p-5 dark:border-secondary-800"
    >
      <div class="flex items-start gap-3">
        <span class="icon-[annon--info] mt-0.5 size-5 shrink-0 text-muted" aria-hidden="true" />
        <div class="min-w-0 flex-1">
          <div class="flex items-center gap-2">
            <h3 class="text-sm font-medium text-heading dark:text-secondary-100">
              {{ infoCard.title }}
            </h3>
            <AtomsBadge variant="secondary" size="sm">
              {{ infoCard.badge }}
            </AtomsBadge>
          </div>
          <p class="mt-1 text-sm text-muted">
            {{ infoCard.description }}
          </p>
        </div>
      </div>
    </div>

    <!-- Current plan (managed profiles only) -->
    <div
      v-else
      class="rounded-lg border border-secondary-200 p-5 dark:border-secondary-800"
    >
      <div class="flex items-center justify-between">
        <div>
          <h3 class="text-sm font-medium text-heading dark:text-secondary-100">
            {{ t('billing.current_plan') }}
          </h3>
          <div class="mt-2 flex items-center gap-3">
            <span class="text-2xl font-bold text-heading dark:text-secondary-100">
              {{ planName }}
            </span>
            <AtomsBadge :variant="stateBadgeVariant" size="sm">
              {{ stateLabel }}
            </AtomsBadge>
          </div>
          <!-- A prepaid year was paid with the Migrate order: no monthly price, no portal behind it. -->
          <p v-if="prepaidUntil" class="mt-1 text-sm text-muted" data-testid="prepaid-through">
            {{ t('billing.prepaid_through', { date: longDate(prepaidUntil) }) }}
          </p>
          <p v-else-if="planPrice > 0" class="mt-1 text-sm text-muted">
            ${{ planPrice }}{{ t('plans.per_month') }}
          </p>
        </div>

        <p v-if="!isOwnerOrAdmin" class="max-w-56 text-right text-xs text-muted">
          {{ t('billing.ask_owner') }}
        </p>
        <div v-else-if="prepaidUntil" class="flex gap-2">
          <!-- The "Keep Studio" subscription is managed (or cancelled) in the provider's portal. -->
          <AtomsBaseButton
            v-if="renewalPlan"
            variant="secondary"
            size="sm"
            :loading="loading"
            @click="handleManageSubscription"
          >
            {{ t('billing.manage_subscription') }}
          </AtomsBaseButton>
        </div>
        <div v-else class="flex gap-2">
          <AtomsBaseButton
            v-if="hasSubscription"
            variant="secondary"
            size="sm"
            :loading="loading"
            @click="handleManageSubscription"
          >
            {{ t('billing.manage_subscription') }}
          </AtomsBaseButton>
          <AtomsBaseButton
            v-else
            variant="primary"
            size="sm"
            @click="planModalOpen = true"
          >
            {{ t('billing.upgrade') }}
          </AtomsBaseButton>
        </div>
      </div>

      <!-- Trial info -->
      <div v-if="isTrialing" class="mt-4 rounded-md bg-primary-50 px-4 py-3 dark:bg-primary-950/30">
        <div class="flex items-center gap-2 text-sm text-primary-700 dark:text-primary-300">
          <span class="icon-[annon--clock] size-4" aria-hidden="true" />
          <span>{{ t('billing.trial_days_left', { days: trialDaysLeft }) }}</span>
        </div>
      </div>

      <!-- Scheduled cancellation: when the plan ends, and the way back. -->
      <div v-if="cancelsAt" class="mt-4 rounded-md bg-warning-50 px-4 py-3 dark:bg-warning-950/30" data-testid="cancel-scheduled">
        <div class="flex flex-wrap items-center gap-2 text-sm text-warning-800 dark:text-warning-200">
          <span class="icon-[annon--clock] size-4 shrink-0" aria-hidden="true" />
          <span class="min-w-0 flex-1">
            {{ t('billing.cancel_scheduled', { plan: planName, date: new Date(cancelsAt).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' }) }) }}
          </span>
          <AtomsBaseButton
            v-if="isOwnerOrAdmin && hasSubscription"
            variant="secondary"
            size="sm"
            :loading="loading"
            @click="handleManageSubscription"
          >
            {{ t('billing.cancel_undo') }}
          </AtomsBaseButton>
          <span v-else class="text-xs">{{ t('billing.ask_owner') }}</span>
        </div>
      </div>

      <!-- Prepaid year: what follows it. Nothing renews by itself. -->
      <div v-if="prepaidUntil" class="mt-4 rounded-md bg-secondary-50 px-4 py-3 dark:bg-secondary-900" data-testid="keep-studio">
        <p v-if="renewalPlan" class="flex items-center gap-2 text-sm text-body dark:text-secondary-300">
          <span class="icon-[annon--check-circle] size-4 shrink-0 text-success-500" aria-hidden="true" />
          {{ t('billing.keep_studio_scheduled', { plan: PLAN_PRICING[renewalPlan]?.name ?? renewalPlan, date: longDate(prepaidUntil), price: yearlyPrice(renewalPlan) }) }}
        </p>
        <template v-else-if="prepaidRenewalOpen">
          <p class="text-sm text-body dark:text-secondary-300">
            {{ t('billing.keep_studio_description', { date: longDate(prepaidUntil) }) }}
          </p>
          <div v-if="isOwnerOrAdmin" class="mt-3 flex flex-wrap gap-2">
            <AtomsBaseButton
              v-for="plan in keepPlans"
              :key="plan"
              :variant="plan === effectivePlan ? 'primary' : 'secondary'"
              size="sm"
              :loading="keepingPlan === plan"
              :disabled="keepingPlan !== null"
              @click="handleKeepStudio(plan)"
            >
              {{ t('billing.keep_studio_choose', { plan: PLAN_PRICING[plan]?.name ?? plan, price: yearlyPrice(plan) }) }}
            </AtomsBaseButton>
          </div>
          <p v-else class="mt-2 text-xs text-muted">
            {{ t('billing.ask_owner') }}
          </p>
        </template>
        <p v-else-if="prepaidRenewalOpensAt" class="text-sm text-muted">
          {{ t('billing.keep_studio_opens', { date: longDate(prepaidRenewalOpensAt) }) }}
        </p>
      </div>

      <!-- Past due warning -->
      <div v-if="billingState === 'past_due'" class="mt-4 rounded-md bg-danger-50 px-4 py-3 dark:bg-danger-950/30">
        <div class="flex items-center gap-2 text-sm text-danger-700 dark:text-danger-300">
          <span class="icon-[annon--alert-triangle] size-4" aria-hidden="true" />
          <span>{{ t('billing.payment_failed_detail') }}</span>
        </div>
      </div>
    </div>

    <!-- Usage dashboard — shown for any workspace with a non-free effective plan, which covers managed subscribers, on-premise enterprise, and community (always 'community' tier → still useful for metering visibility). -->
    <OrganismsWorkspaceUsagePanel
      v-if="hasSubscription || effectivePlan !== 'free'"
      :workspace-id="workspaceId"
    />

    <!-- Plan selection modal (managed only) -->
    <OrganismsPlanSelectionModal
      v-if="deployment.hasManagedBilling.value"
      :open="planModalOpen"
      @update:open="planModalOpen = $event"
    />
  </div>
</template>

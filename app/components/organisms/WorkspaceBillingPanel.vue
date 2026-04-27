<script setup lang="ts">
import { PLAN_PRICING } from '~~/shared/utils/license'

const { t } = useContent()
const { billingState, effectivePlan, isTrialing, trialDaysLeft, openPortal } = useBilling()
const deployment = useDeployment()

defineProps<{
  workspaceId: string
}>()

const planModalOpen = ref(false)
const loading = ref(false)

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
    case 'subscribed': return t('billing.state_active')
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
    case 'subscribed': return 'success' as const
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
  catch {
    // Portal redirect failed — user stays on page
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
          <p v-if="planPrice > 0" class="mt-1 text-sm text-muted">
            ${{ planPrice }}{{ t('plans.per_month') }}
          </p>
        </div>

        <div class="flex gap-2">
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

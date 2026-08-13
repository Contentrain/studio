<script setup lang="ts">
import { PLAN_PRICING } from '~~/shared/utils/license'

const { t } = useContent()
const { billingState, trialDaysLeft, effectivePlan } = useBilling()
const route = useRoute()

const planName = computed(() => PLAN_PRICING[effectivePlan.value]?.name ?? effectivePlan.value)

const emit = defineEmits<{
  choosePlan: []
  manageBilling: []
}>()

const isRelevant = computed(() =>
  ['free', 'trial_active', 'past_due', 'trial_expired', 'grace_expired', 'canceled_expired'].includes(billingState.value),
)

const isExpired = computed(() =>
  ['trial_expired', 'grace_expired', 'canceled_expired'].includes(billingState.value),
)

const isPastDue = computed(() => billingState.value === 'past_due')
const isFree = computed(() => billingState.value === 'free')
const isTrialing = computed(() => billingState.value === 'trial_active')
const isUrgent = computed(() => isTrialing.value && trialDaysLeft.value <= 3)

/**
 * Dismissal is scoped to the billing state that produced the notice, so a
 * state change (trial_active → past_due) always re-surfaces the banner
 * without any extra invalidation.
 */
const DISMISS_KEY = 'contentrain-billing-banner-dismissed'

/**
 * States that demand action stay pushy: dismissing them only lasts until the
 * next navigation, and never reaches sessionStorage. Expired states belong
 * here too — the paywall replaces the page content on most routes, but
 * `/w/:slug/settings` is deliberately exempt (see app/layouts/default.vue),
 * so that is exactly where an expired banner still renders.
 */
const isUrgentNotice = computed(() => isPastDue.value || isExpired.value)

const dismissedState = ref<string | null>(null)

// SPA (nuxt.config.ts `ssr: false`) — reading storage during setup is safe.
if (import.meta.client) {
  dismissedState.value = sessionStorage.getItem(DISMISS_KEY)
}

watch(() => route.path, () => {
  if (isUrgentNotice.value) dismissedState.value = null
})

const isVisible = computed(() => isRelevant.value && dismissedState.value !== billingState.value)

function dismiss() {
  dismissedState.value = billingState.value
  if (!isUrgentNotice.value && import.meta.client) {
    sessionStorage.setItem(DISMISS_KEY, billingState.value)
  }
}

const bannerText = computed(() => {
  if (isExpired.value) return t('trial.expired_text')
  if (isPastDue.value) return t('billing.payment_failed')
  if (isFree.value) return t('billing.upgrade_to_connect')
  if (trialDaysLeft.value === 1) return t('trial.banner_last_day')
  if (trialDaysLeft.value === 0) return t('trial.banner_last_day')
  return t('trial.banner_text', { days: trialDaysLeft.value })
})

const ctaText = computed(() => {
  if (isPastDue.value) return t('billing.update_payment')
  if (isFree.value) return t('billing.upgrade')
  return t('trial.choose_plan')
})

function handleCta() {
  if (isPastDue.value) emit('manageBilling')
  else emit('choosePlan')
}
</script>

<template>
  <!-- Full-width strip on mobile, floating pill from `md` up — the layout
       pairs the pill with `md:absolute`, so it must stay shrink-to-fit. -->
  <div
    v-if="isVisible"
    :role="isUrgentNotice ? 'alert' : 'status'"
    class="flex items-center gap-2 border-b px-4 py-2 text-sm md:max-w-[min(32rem,60vw)] md:rounded-full md:border md:py-1.5 md:pr-2 md:shadow-lg"
    :class="[
      isExpired || isPastDue
        ? 'border-danger-200 bg-danger-50 text-danger-700 dark:border-danger-500/30 dark:bg-danger-950 dark:text-danger-300'
        : isUrgent
          ? 'border-warning-200 bg-warning-50 text-warning-700 dark:border-warning-500/30 dark:bg-warning-950 dark:text-warning-300'
          : isFree
            ? 'border-secondary-200 bg-secondary-50 text-secondary-600 dark:border-secondary-700 dark:bg-secondary-900 dark:text-secondary-300'
            : 'border-primary-200 bg-primary-50 text-primary-700 dark:border-primary-500/30 dark:bg-primary-950 dark:text-primary-300',
    ]"
  >
    <span
      class="size-4 shrink-0"
      :class="[
        isExpired || isPastDue ? 'icon-[annon--alert-triangle]' : isFree ? 'icon-[annon--star]' : 'icon-[annon--clock]',
      ]"
      aria-hidden="true"
    />
    <span class="min-w-0 flex-1 truncate">{{ bannerText }}</span>
    <AtomsBadge v-if="isTrialing" variant="primary" size="sm" class="shrink-0">
      {{ planName }}
    </AtomsBadge>

    <button
      type="button"
      class="shrink-0 rounded-md px-3 py-1 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50"
      :class="[
        isExpired || isPastDue
          ? 'bg-danger-600 text-white hover:bg-danger-700'
          : 'bg-primary-600 text-white hover:bg-primary-700',
      ]"
      @click="handleCta"
    >
      {{ ctaText }}
    </button>

    <button
      type="button"
      class="shrink-0 rounded p-1 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50"
      :class="[
        isExpired || isPastDue
          ? 'text-danger-500 hover:bg-danger-100 hover:text-danger-700 dark:hover:bg-danger-900/50 dark:hover:text-danger-300'
          : isUrgent
            ? 'text-warning-500 hover:bg-warning-100 hover:text-warning-700 dark:hover:bg-warning-900/50 dark:hover:text-warning-300'
            : isFree
              ? 'text-muted hover:bg-secondary-200 hover:text-body dark:hover:bg-secondary-800 dark:hover:text-secondary-100'
              : 'text-primary-500 hover:bg-primary-100 hover:text-primary-700 dark:hover:bg-primary-900/50 dark:hover:text-primary-300',
      ]"
      @click="dismiss"
    >
      <span class="icon-[annon--cross] block size-3.5" aria-hidden="true" />
      <span class="sr-only">{{ t('common.dismiss') }}</span>
    </button>
  </div>
</template>

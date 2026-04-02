<script setup lang="ts">
const { t } = useContent()
const { billingState, trialDaysLeft, effectivePlan } = useBilling()

const emit = defineEmits<{
  choosePlan: []
  manageBilling: []
}>()

const isVisible = computed(() =>
  ['free', 'trial_active', 'past_due', 'trial_expired', 'grace_expired', 'canceled_expired'].includes(billingState.value),
)

const isExpired = computed(() =>
  ['trial_expired', 'grace_expired', 'canceled_expired'].includes(billingState.value),
)

const isPastDue = computed(() => billingState.value === 'past_due')
const isFree = computed(() => billingState.value === 'free')
const isTrialing = computed(() => billingState.value === 'trial_active')
const isUrgent = computed(() => isTrialing.value && trialDaysLeft.value <= 3)

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
  <div
    v-if="isVisible"
    class="flex items-center justify-between px-4 py-2 text-sm"
    :class="[
      isExpired || isPastDue
        ? 'bg-danger-50 text-danger-700 dark:bg-danger-950 dark:text-danger-300'
        : isUrgent
          ? 'bg-warning-50 text-warning-700 dark:bg-warning-950 dark:text-warning-300'
          : isFree
            ? 'bg-secondary-50 text-secondary-600 dark:bg-secondary-900 dark:text-secondary-300'
            : 'bg-primary-50 text-primary-700 dark:bg-primary-950 dark:text-primary-300',
    ]"
  >
    <div class="flex items-center gap-2">
      <span
        class="size-4"
        :class="[
          isExpired || isPastDue ? 'icon-[annon--alert-triangle]' : isFree ? 'icon-[annon--sparkle]' : 'icon-[annon--clock]',
        ]"
        aria-hidden="true"
      />
      <span>{{ bannerText }}</span>
      <AtomsBadge v-if="isTrialing" variant="primary" size="sm">
        {{ effectivePlan }}
      </AtomsBadge>
    </div>

    <button
      type="button"
      class="rounded-md px-3 py-1 text-xs font-medium transition-colors"
      :class="[
        isExpired || isPastDue
          ? 'bg-danger-600 text-white hover:bg-danger-700'
          : isFree
            ? 'bg-primary-600 text-white hover:bg-primary-700'
            : 'bg-primary-600 text-white hover:bg-primary-700',
      ]"
      @click="handleCta"
    >
      {{ ctaText }}
    </button>
  </div>
</template>

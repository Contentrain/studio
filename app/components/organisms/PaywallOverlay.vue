<script setup lang="ts">
/**
 * Proactive paywall shown in place of workspace content when the active
 * workspace is in a locked billing state (trial_expired / grace_expired
 * / canceled_expired). The server already 402s workspace-scoped API
 * routes in these states; this surface gives the user a path to pay
 * instead of hitting silent failures.
 *
 * - Owner/Admin see an actionable CTA: "Choose a plan" (re-subscribe /
 *   start over) or "Update payment method" (recover a failed payment).
 * - Members see an explanatory message (they cannot pay).
 *
 * Mounted by the `default` layout, gated to workspace routes — see
 * `app/layouts/default.vue`.
 */

const { t } = useContent()
const { billingState, openPortal } = useBilling()
const { isOwnerOrAdmin } = useWorkspaceRole()
const { show: showPlanModal } = usePlanModal()

const title = computed(() => {
  switch (billingState.value) {
    case 'grace_expired': return t('paywall.grace_expired_title')
    case 'canceled_expired': return t('paywall.canceled_expired_title')
    default: return t('paywall.trial_expired_title')
  }
})

const description = computed(() =>
  isOwnerOrAdmin.value ? t('paywall.locked_description') : t('paywall.member_locked_description'),
)

// A grace-period lockout follows a failed charge → send the owner to the
// provider portal to fix their card. Trial / cancellation lockouts need a
// (fresh) plan selection.
const isPaymentRecovery = computed(() => billingState.value === 'grace_expired')

const loading = ref(false)

async function handleAction() {
  if (isPaymentRecovery.value) {
    loading.value = true
    try {
      await openPortal()
    }
    finally {
      loading.value = false
    }
    return
  }
  showPlanModal()
}
</script>

<template>
  <div class="flex min-h-full items-center justify-center p-6">
    <div class="w-full max-w-md rounded-xl border border-secondary-200 bg-white p-8 text-center shadow-sm dark:border-secondary-800 dark:bg-secondary-900">
      <div class="mx-auto mb-4 flex size-12 items-center justify-center rounded-full bg-warning-100 dark:bg-warning-950">
        <span class="icon-[annon--lock] size-6 text-warning-600 dark:text-warning-400" aria-hidden="true" />
      </div>
      <h2 class="text-lg font-semibold text-heading dark:text-secondary-100">
        {{ title }}
      </h2>
      <p class="mt-2 text-sm text-body dark:text-secondary-300">
        {{ description }}
      </p>
      <AtomsBaseButton
        v-if="isOwnerOrAdmin"
        variant="primary"
        size="md"
        :loading="loading"
        class="mt-6 w-full"
        @click="handleAction"
      >
        {{ isPaymentRecovery ? t('paywall.update_payment') : t('paywall.choose_plan') }}
      </AtomsBaseButton>
    </div>
  </div>
</template>

<script setup lang="ts">
import { DialogClose, DialogContent, DialogDescription, DialogOverlay, DialogPortal, DialogRoot, DialogTitle } from 'radix-vue'
import { PLAN_PRICING } from '~~/shared/utils/license'

const { t } = useContent()
const { billingState, effectivePlan, startCheckout, openPortal } = useBilling()
const toast = useToast()

const props = defineProps<{
  open: boolean
}>()

const emit = defineEmits<{
  'update:open': [value: boolean]
}>()

const loading = ref<string | null>(null)

const plans = [
  {
    slug: 'starter' as const,
    name: PLAN_PRICING.starter.name,
    price: PLAN_PRICING.starter.priceMonthly,
    seat: PLAN_PRICING.starter.pricePerSeat,
    seatsIncluded: PLAN_PRICING.starter.seatsIncluded,
    aiModel: 'Haiku',
    highlighted: false,
    features: [
      '50 AI messages/mo',
      '2 GB CDN bandwidth',
      '1 GB media storage',
      '1 form, 100 submissions',
      '3 team members',
      '3 webhook endpoints',
      'Review workflow',
      'BYOA unlimited',
    ],
  },
  {
    slug: 'pro' as const,
    name: PLAN_PRICING.pro.name,
    price: PLAN_PRICING.pro.priceMonthly,
    seat: PLAN_PRICING.pro.pricePerSeat,
    seatsIncluded: PLAN_PRICING.pro.seatsIncluded,
    aiModel: 'Sonnet',
    highlighted: true,
    features: [
      '500 AI messages/mo',
      '20 GB CDN bandwidth',
      '5 GB media storage',
      '5 forms, 1K submissions',
      '25 team members',
      '10 webhook endpoints',
      'Custom image variants',
      'Model-specific access',
      'CDN preview branches',
      'Spam filter',
      'BYOA unlimited',
    ],
  },
]

const hasActiveSubscription = computed(() =>
  ['subscribed', 'trial_active', 'past_due', 'canceled'].includes(billingState.value),
)

const ctaLabel = computed(() => {
  if (hasActiveSubscription.value) return t('billing.manage_subscription')
  return t('billing.start_trial')
})

async function handlePlanAction(slug: 'starter' | 'pro') {
  // If already subscribed, open Stripe Portal for plan changes
  if (hasActiveSubscription.value) {
    loading.value = slug
    try {
      await openPortal()
    }
    catch (err: unknown) {
      const message = (err as { data?: { message?: string } })?.data?.message ?? t('generic.server_error')
      toast.error(message)
    }
    finally {
      loading.value = null
    }
    return
  }

  // Otherwise start Stripe Checkout with 14-day trial
  loading.value = slug
  try {
    await startCheckout(slug)
    // Redirect happens in startCheckout — this code only runs if it fails
  }
  catch (err: unknown) {
    const message = (err as { data?: { message?: string } })?.data?.message ?? t('generic.server_error')
    toast.error(message)
  }
  finally {
    loading.value = null
  }
}
</script>

<template>
  <DialogRoot :open="props.open" @update:open="emit('update:open', $event)">
    <DialogPortal>
      <DialogOverlay
        class="fixed inset-0 z-50 bg-black/50 data-[state=open]:animate-in data-[state=open]:fade-in data-[state=closed]:animate-out data-[state=closed]:fade-out"
      />
      <DialogContent
        class="fixed left-1/2 top-1/2 z-50 flex w-full max-w-3xl -translate-x-1/2 -translate-y-1/2 flex-col rounded-xl border border-secondary-200 bg-white shadow-xl dark:border-secondary-800 dark:bg-secondary-950"
        @interact-outside.prevent
      >
        <!-- Header -->
        <div class="flex shrink-0 items-center justify-between border-b border-secondary-200 px-6 py-4 dark:border-secondary-800">
          <div>
            <DialogTitle class="text-base font-semibold text-heading dark:text-secondary-100">
              {{ t('plans.select_title') }}
            </DialogTitle>
            <DialogDescription class="mt-1 text-sm text-muted">
              {{ hasActiveSubscription ? t('plans.manage_description') : t('plans.trial_description') }}
            </DialogDescription>
          </div>
          <DialogClose
            class="rounded-md p-1 text-muted transition-colors hover:bg-secondary-100 hover:text-heading focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50 dark:hover:bg-secondary-800 dark:hover:text-secondary-100"
          >
            <span class="icon-[annon--cross] block size-4" aria-hidden="true" />
          </DialogClose>
        </div>

        <!-- Plan cards -->
        <div class="grid grid-cols-2 gap-4 overflow-y-auto p-6">
          <div
            v-for="plan in plans"
            :key="plan.slug"
            class="relative flex flex-col rounded-lg border p-5 transition-colors"
            :class="[
              plan.highlighted
                ? 'border-primary-500 bg-primary-50/50 dark:border-primary-400 dark:bg-primary-950/30'
                : 'border-secondary-200 dark:border-secondary-800',
              effectivePlan === plan.slug && 'ring-2 ring-primary-500/50',
            ]"
          >
            <!-- Popular badge -->
            <AtomsBadge v-if="plan.highlighted" variant="primary" size="sm" class="absolute -top-2.5 right-3">
              {{ t('plans.most_popular') }}
            </AtomsBadge>

            <!-- Current plan badge -->
            <AtomsBadge v-if="effectivePlan === plan.slug" variant="success" size="sm" class="absolute -top-2.5 left-3">
              {{ t('plans.current_plan') }}
            </AtomsBadge>

            <!-- Plan name & price -->
            <div class="mb-4">
              <h3 class="text-lg font-semibold text-heading dark:text-secondary-100">
                {{ plan.name }}
              </h3>
              <div class="mt-1 flex items-baseline gap-1">
                <span class="text-3xl font-bold text-heading dark:text-secondary-100">${{ plan.price }}</span>
                <span class="text-sm text-muted">{{ t('plans.per_month') }}</span>
              </div>
              <p v-if="plan.seat" class="mt-1 text-xs text-muted">
                +${{ plan.seat }} {{ t('plans.per_seat') }}
              </p>
              <p class="mt-1 text-xs text-muted">
                {{ t('plans.seats_included', { count: plan.seatsIncluded }) }}
              </p>
            </div>

            <!-- Trial info -->
            <p v-if="!hasActiveSubscription" class="mb-3 text-xs font-medium text-success-600 dark:text-success-400">
              {{ t('billing.trial_14_days') }}
            </p>

            <!-- Features -->
            <ul class="mb-5 flex-1 space-y-2">
              <li v-for="feature in plan.features" :key="feature" class="flex items-start gap-2 text-sm text-body dark:text-secondary-300">
                <span class="icon-[annon--check] mt-0.5 size-4 shrink-0 text-success-500" aria-hidden="true" />
                {{ feature }}
              </li>
            </ul>

            <!-- CTA -->
            <AtomsBaseButton
              :variant="plan.highlighted ? 'primary' : 'secondary'"
              size="md"
              :disabled="loading !== null"
              :loading="loading === plan.slug"
              class="w-full"
              @click="handlePlanAction(plan.slug)"
            >
              {{ effectivePlan === plan.slug && hasActiveSubscription ? t('plans.current_plan') : ctaLabel }}
            </AtomsBaseButton>
          </div>
        </div>

        <!-- Enterprise CTA -->
        <div class="flex items-center justify-between border-t border-secondary-200 px-6 py-4 dark:border-secondary-800">
          <div>
            <p class="text-sm font-medium text-heading dark:text-secondary-100">
              Enterprise
            </p>
            <p class="text-xs text-muted">
              {{ t('plans.enterprise_description') }}
            </p>
          </div>
          <AtomsBaseButton variant="ghost" size="sm">
            {{ t('plans.contact_sales') }}
          </AtomsBaseButton>
        </div>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>

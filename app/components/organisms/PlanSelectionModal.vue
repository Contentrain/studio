<script setup lang="ts">
import { DialogClose, DialogContent, DialogDescription, DialogOverlay, DialogPortal, DialogRoot, DialogTitle } from 'radix-vue'
import { query } from '#contentrain'
import type { PlanFeatures } from '#contentrain'
import { ENTERPRISE_CONTACT_EMAIL } from '~~/shared/utils/license'

const { t } = useContent()
const { billingState, effectivePlan, startCheckout, openPortal } = useBilling()

const enterpriseMailto = computed(() => {
  const subject = encodeURIComponent('Contentrain Studio — Enterprise inquiry')
  return `mailto:${ENTERPRISE_CONTACT_EMAIL}?subject=${subject}`
})
const toast = useToast()

const props = defineProps<{
  open: boolean
}>()

const emit = defineEmits<{
  'update:open': [value: boolean]
}>()

const loading = ref<string | null>(null)

// Load plans from Contentrain — sorted by sort_order, exclude free (shown implicitly)
const plans = computed(() =>
  query('plans')
    .locale('en')
    .sort('sort_order', 'asc')
    .all()
    .filter(p => p.slug !== 'free' && p.slug !== 'enterprise'),
)

// Load features grouped by plan for display
const allFeatures = computed(() =>
  query('plan-features')
    .sort('sort_order', 'asc')
    .all(),
)

function planFeaturesList(planSlug: string): string[] {
  const valueKey = `${planSlug}_value` as keyof PlanFeatures
  return allFeatures.value
    .filter((f) => {
      const val = f[valueKey] as string | undefined
      return val && val !== 'false' && val !== '0'
    })
    .map((f) => {
      const val = f[valueKey] as string
      if (f.type === 'limit') {
        return val === 'unlimited' ? `${f.name}: ${t('common.unlimited')}` : `${val} ${f.name}`
      }
      return f.name
    })
}

// Enterprise plan from Contentrain
const enterprisePlan = computed(() =>
  query('plans')
    .locale('en')
    .where('slug', 'enterprise')
    .all()[0],
)

const hasActiveSubscription = computed(() =>
  ['subscribed', 'trial_active', 'past_due', 'canceled'].includes(billingState.value),
)

const ctaLabel = computed(() => {
  if (hasActiveSubscription.value) return t('billing.manage_subscription')
  return t('billing.start_trial')
})

async function handlePlanAction(slug: string) {
  if (slug !== 'starter' && slug !== 'pro') return

  if (hasActiveSubscription.value) {
    loading.value = slug
    try {
      await openPortal()
    }
    catch (err: unknown) {
      toast.error(resolveApiError(err, t('common.server_error')))
    }
    finally {
      loading.value = null
    }
    return
  }

  loading.value = slug
  try {
    await startCheckout(slug)
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
              plan.is_highlighted
                ? 'border-primary-500 bg-primary-50/50 dark:border-primary-400 dark:bg-primary-950/30'
                : 'border-secondary-200 dark:border-secondary-800',
              effectivePlan === plan.slug && 'ring-2 ring-primary-500/50',
            ]"
          >
            <!-- Popular badge -->
            <AtomsBadge v-if="plan.is_highlighted" variant="primary" size="sm" class="absolute -top-2.5 right-3">
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
                <span class="text-3xl font-bold text-heading dark:text-secondary-100">${{ plan.price_monthly }}</span>
                <span class="text-sm text-muted">{{ t('plans.per_month') }}</span>
              </div>
              <p class="mt-1 text-xs text-muted">
                {{ t('plans.seats_included', { count: plan.seats_included }) }}
              </p>
            </div>

            <!-- Trial info -->
            <p v-if="plan.has_trial && !hasActiveSubscription" class="mb-3 text-xs font-medium text-success-600 dark:text-success-400">
              {{ t('billing.trial_14_days') }}
            </p>

            <!-- Features from Contentrain plan-features -->
            <ul class="mb-5 flex-1 space-y-2">
              <li v-for="feature in planFeaturesList(plan.slug)" :key="feature" class="flex items-start gap-2 text-sm text-body dark:text-secondary-300">
                <span class="icon-[annon--check] mt-0.5 size-4 shrink-0 text-success-500" aria-hidden="true" />
                {{ feature }}
              </li>
            </ul>

            <!-- CTA -->
            <AtomsBaseButton
              :variant="plan.is_highlighted ? 'primary' : 'secondary'"
              size="md"
              :disabled="loading !== null"
              :loading="loading === plan.slug"
              class="w-full"
              @click="handlePlanAction(plan.slug)"
            >
              {{ effectivePlan === plan.slug && hasActiveSubscription ? t('plans.current_plan') : plan.has_trial && !hasActiveSubscription ? plan.cta_text : ctaLabel }}
            </AtomsBaseButton>
          </div>
        </div>

        <!-- Enterprise CTA -->
        <div v-if="enterprisePlan" class="flex items-center justify-between border-t border-secondary-200 px-6 py-4 dark:border-secondary-800">
          <div>
            <p class="text-sm font-medium text-heading dark:text-secondary-100">
              {{ enterprisePlan.name }}
            </p>
            <p class="text-xs text-muted">
              {{ enterprisePlan.description }}
            </p>
          </div>
          <a
            :href="enterpriseMailto"
            class="inline-flex h-9 items-center justify-center rounded-md border border-border px-3 text-sm font-medium text-heading transition-colors hover:bg-secondary-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50 dark:border-secondary-800 dark:text-secondary-100 dark:hover:bg-secondary-900"
          >
            {{ enterprisePlan.cta_text }}
          </a>
        </div>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>

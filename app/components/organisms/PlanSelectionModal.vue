<script setup lang="ts">
import { DialogClose, DialogContent, DialogDescription, DialogOverlay, DialogPortal, DialogRoot, DialogTitle } from 'radix-vue'
import { query } from '#contentrain'
import type { PlanFeatures } from '#contentrain'
import { ENTERPRISE_CONTACT_EMAIL } from '~~/shared/utils/license'

const { t } = useContent()
const { billingState, effectivePlan, trialConsumed, startCheckout, openPortal } = useBilling()

const props = defineProps<{
  open: boolean
}>()

const emit = defineEmits<{
  'update:open': [value: boolean]
}>()

const toast = useToast()
const loading = ref<string | null>(null)

const enterpriseMailto = computed(() => {
  const subject = encodeURIComponent('Contentrain Studio — Enterprise inquiry')
  return `mailto:${ENTERPRISE_CONTACT_EMAIL}?subject=${subject}`
})

// Purchasable plans only. Exclude:
//   - `free`      — the no-subscription shell (not selectable)
//   - `community` — the self-hosted edition tier; its limits are
//     "unlimited" because Community Edition doesn't enforce them, which is
//     meaningless + misleading in this managed checkout surface
//   - `enterprise` — contact-sales, rendered separately
const plans = computed(() =>
  query('plans')
    .locale('en')
    .sort('sort_order', 'asc')
    .all()
    .filter(p => p.slug !== 'free' && p.slug !== 'community' && p.slug !== 'enterprise'),
)

const enterprisePlan = computed(() =>
  query('plans')
    .locale('en')
    .where('slug', 'enterprise')
    .all()[0],
)

// All plan-feature rows (features + limits), single source of truth.
const allFeatures = computed(() =>
  query('plan-features').all(),
)

const hasActiveSubscription = computed(() =>
  ['subscribed', 'trial_active', 'past_due', 'canceled'].includes(billingState.value),
)

/**
 * Headline usage dimensions shown in the "Usage limits" block — the six
 * metered limits that carry overage pricing. These are exactly the
 * "pick your usage level" axes that differentiate the tiers; pure caps
 * (key counts, endpoint counts) are enforced server-side but kept off
 * the card to avoid drowning the comparison.
 */
const HEADLINE_LIMITS = [
  'ai.messages_per_month',
  'api.messages_per_month',
  'api.mcp_calls_per_month',
  'forms.submissions_per_month',
  'media.storage_gb',
  'cdn.bandwidth_gb',
] as const

function isTruthy(val: string | undefined | null): boolean {
  return Boolean(val) && val !== 'false' && val !== '0'
}

/** Group integers with thousands separators, locale-independent. */
function groupNumber(n: number): string {
  return n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

/** Strip a trailing "(GB)" / "(MB)" unit hint baked into the row name. */
function cleanLimitName(name: string): string {
  return name.replace(/\s*\((?:GB|MB)\)\s*$/i, '')
}

/** Format a raw limit value for display: unlimited / GB suffix / grouped. */
function formatLimitValue(raw: string, key: string): string {
  if (raw === 'unlimited' || raw === '') return t('common.unlimited')
  const n = Number(raw)
  if (!Number.isFinite(n)) return raw
  if (key.endsWith('_gb')) return `${groupNumber(n)} GB`
  return groupNumber(n)
}

function valueKeyFor(slug: string): keyof PlanFeatures {
  return `${slug}_value` as keyof PlanFeatures
}

interface LimitRow {
  key: string
  label: string
  value: string
}

/** Headline metered limits with the plan's value, in display order. */
function limitRows(slug: string): LimitRow[] {
  const vKey = valueKeyFor(slug)
  return HEADLINE_LIMITS
    .map(key => allFeatures.value.find(f => f.key === key))
    .filter((f): f is PlanFeatures => Boolean(f))
    .map((f) => {
      const raw = String((f[vKey] as string | undefined) ?? '')
      return { key: f.key, label: cleanLimitName(f.name), raw, value: formatLimitValue(raw, f.key) }
    })
    .filter(r => r.raw !== '0' && r.raw !== '')
    .map(({ key, label, value }) => ({ key, label, value }))
}

function byCategoryThenOrder(a: PlanFeatures, b: PlanFeatures): number {
  const catA = a.category ?? ''
  const catB = b.category ?? ''
  if (catA !== catB) return catA < catB ? -1 : 1
  return (a.sort_order ?? 0) - (b.sort_order ?? 0)
}

/**
 * Feature-type rows granted by a plan. For Pro, only the delta over
 * Starter (so the card reads "Everything in Starter, plus …"). Roadmap
 * rows are excluded here and surfaced separately as "Coming soon".
 */
function includedRows(slug: string): string[] {
  const vKey = valueKeyFor(slug)
  const prevKey = slug === 'pro' ? valueKeyFor('starter') : null
  return allFeatures.value
    .filter(f => f.type === 'feature')
    .filter(f => isTruthy(f[vKey] as string | undefined) && !isTruthy(f.roadmap))
    .filter(f => !prevKey || !isTruthy(f[prevKey] as string | undefined))
    .sort(byCategoryThenOrder)
    .map(f => f.name)
}

/** Advertised-but-unimplemented features granted by a plan (delta for Pro). */
function comingSoonRows(slug: string): string[] {
  const vKey = valueKeyFor(slug)
  const prevKey = slug === 'pro' ? valueKeyFor('starter') : null
  return allFeatures.value
    .filter(f => f.type === 'feature')
    .filter(f => isTruthy(f[vKey] as string | undefined) && isTruthy(f.roadmap))
    .filter(f => !prevKey || !isTruthy(f[prevKey] as string | undefined))
    .sort(byCategoryThenOrder)
    .map(f => f.name)
}

function aiModelLabel(tier: string | undefined): string {
  switch (tier) {
    case 'haiku': return t('plans.ai_model_haiku')
    case 'sonnet': return t('plans.ai_model_sonnet')
    case 'custom': return t('plans.ai_model_custom')
    default: return t('plans.ai_model_none')
  }
}

interface PlanCta {
  label: string
  disabled: boolean
}

function ctaFor(slug: string): PlanCta {
  if (effectivePlan.value === slug && hasActiveSubscription.value)
    return { label: t('plans.current_plan'), disabled: true }
  if (hasActiveSubscription.value)
    return { label: t('billing.manage_subscription'), disabled: false }
  // Trial already used → no second trial; offer a direct paid subscription.
  if (trialConsumed.value)
    return { label: t('plans.subscribe'), disabled: false }
  return { label: t('plans.start_trial'), disabled: false }
}

async function handlePlanAction(slug: string) {
  if (slug !== 'starter' && slug !== 'pro') return
  if (ctaFor(slug).disabled) return

  loading.value = slug
  try {
    if (hasActiveSubscription.value) {
      await openPortal()
    }
    else {
      await startCheckout(slug)
    }
  }
  catch (err: unknown) {
    toast.error(resolveApiError(err, t('common.server_error')))
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
        class="fixed left-1/2 top-1/2 z-50 flex max-h-[90vh] w-full max-w-3xl -translate-x-1/2 -translate-y-1/2 flex-col rounded-xl border border-secondary-200 bg-white shadow-xl dark:border-secondary-800 dark:bg-secondary-950"
        @interact-outside.prevent
      >
        <!-- Header -->
        <div class="flex shrink-0 items-center justify-between border-b border-secondary-200 px-6 py-4 dark:border-secondary-800">
          <div>
            <DialogTitle class="text-base font-semibold text-heading dark:text-secondary-100">
              {{ t('plans.select_title') }}
            </DialogTitle>
            <DialogDescription class="mt-1 text-sm text-muted">
              {{ hasActiveSubscription
                ? t('plans.manage_description')
                : trialConsumed
                  ? t('plans.trial_ended_description')
                  : t('plans.select_description') }}
            </DialogDescription>
          </div>
          <DialogClose
            class="rounded-md p-1 text-muted transition-colors hover:bg-secondary-100 hover:text-heading focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50 dark:hover:bg-secondary-800 dark:hover:text-secondary-100"
          >
            <span class="icon-[annon--cross] block size-4" aria-hidden="true" />
          </DialogClose>
        </div>

        <!-- Plan cards -->
        <div class="grid grid-cols-1 gap-4 overflow-y-auto p-6 sm:grid-cols-2">
          <div
            v-for="plan in plans"
            :key="plan.slug"
            class="relative flex flex-col rounded-lg border p-5 transition-colors"
            :class="[
              plan.is_highlighted
                ? 'border-primary-500 bg-primary-50/50 ring-1 ring-primary-500/20 dark:border-primary-500 dark:bg-primary-500/5 dark:ring-primary-500/25'
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

            <!-- Name & price -->
            <div class="mb-3">
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
              <p class="mt-1 flex items-center gap-1.5 text-xs text-muted">
                <span class="icon-[annon--star] size-3.5 shrink-0 text-primary-500" aria-hidden="true" />
                {{ t('plans.ai_model_label') }}: <span class="font-medium text-body dark:text-secondary-300">{{ aiModelLabel(plan.ai_model_tier) }}</span>
              </p>
            </div>

            <!-- Trial info -->
            <p v-if="plan.has_trial && !hasActiveSubscription" class="mb-3 text-xs font-medium text-success-600 dark:text-success-400">
              {{ t('billing.trial_14_days') }}
            </p>

            <!-- Usage limits -->
            <div class="mb-4">
              <p class="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">
                {{ t('plans.limits_title') }}
              </p>
              <ul class="space-y-1.5">
                <li
                  v-for="lim in limitRows(plan.slug)"
                  :key="lim.key"
                  class="flex items-baseline justify-between gap-3 text-sm"
                >
                  <span class="text-body dark:text-secondary-300">{{ lim.label }}</span>
                  <span class="shrink-0 font-semibold tabular-nums text-heading dark:text-secondary-100">{{ lim.value }}</span>
                </li>
              </ul>
            </div>

            <!-- Included features -->
            <div class="mb-5 flex-1">
              <p class="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">
                {{ plan.slug === 'pro' ? t('plans.everything_in_starter_plus') : t('plans.included_title') }}
              </p>
              <ul class="space-y-2">
                <li
                  v-for="feature in includedRows(plan.slug)"
                  :key="feature"
                  class="flex items-start gap-2 text-sm text-body dark:text-secondary-300"
                >
                  <span class="icon-[annon--check] mt-0.5 size-4 shrink-0 text-success-500" aria-hidden="true" />
                  <span class="flex-1">{{ feature }}</span>
                </li>
              </ul>

              <!-- Coming soon (advertised, not yet shipped) -->
              <template v-if="comingSoonRows(plan.slug).length">
                <p class="mb-2 mt-4 text-xs font-semibold uppercase tracking-wide text-muted">
                  {{ t('plans.coming_soon_title') }}
                </p>
                <ul class="space-y-2">
                  <li
                    v-for="feature in comingSoonRows(plan.slug)"
                    :key="feature"
                    class="flex items-start gap-2 text-sm text-muted"
                  >
                    <span class="icon-[annon--clock] mt-0.5 size-4 shrink-0" aria-hidden="true" />
                    <span class="flex-1">{{ feature }}</span>
                  </li>
                </ul>
              </template>
            </div>

            <!-- CTA -->
            <AtomsBaseButton
              :variant="plan.is_highlighted ? 'primary' : 'secondary'"
              size="md"
              :disabled="loading !== null || ctaFor(plan.slug).disabled"
              :loading="loading === plan.slug"
              class="w-full"
              @click="handlePlanAction(plan.slug)"
            >
              {{ ctaFor(plan.slug).label }}
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

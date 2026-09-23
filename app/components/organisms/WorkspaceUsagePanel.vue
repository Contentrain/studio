<script setup lang="ts">
import type { UsageCategory } from '~/composables/useUsage'
import { OVERAGE_PRICING } from '~~/shared/utils/license'

const { t } = useContent()
const { usage, loading, fetchUsage, toggleOverage } = useUsage()
const { billingState, billingEnabled } = useBilling()
const toast = useToast()

defineProps<{
  workspaceId: string
}>()

const togglingKey = ref<string | null>(null)

const hasSubscription = computed(() =>
  ['subscribed', 'trial_active', 'past_due', 'canceled'].includes(billingState.value),
)

// Can toggle overages only with active subscription and billing enabled
const canToggleOverage = computed(() => hasSubscription.value && billingEnabled.value)

onMounted(() => {
  fetchUsage()
})

function overageLockText(lock: NonNullable<UsageCategory['overageLock']>): string {
  if (lock.reason === 'trialing') {
    return lock.until
      ? t('billing.overage_locked_trial', { date: new Date(lock.until).toLocaleDateString('en-US', { month: 'long', day: 'numeric' }) })
      : t('billing.overage_locked_trial_undated')
  }
  return t('billing.overage_locked_subscription')
}

async function handleToggle(settingsKey: string, enabled: boolean) {
  togglingKey.value = settingsKey
  try {
    await toggleOverage(settingsKey, enabled)
  }
  catch (err: unknown) {
    toast.error(resolveApiError(err, t('common.server_error')))
  }
  finally {
    togglingKey.value = null
  }
}

/** Owners and admins manage; members see the meters only. Absent from an older server = manage. */
const canManage = computed(() => usage.value?.canManage !== false)

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', { month: 'long', day: 'numeric', timeZone: 'UTC' })
}

/**
 * When this meter goes back to zero. Each meter carries its own date: AI,
 * API and MCP follow the billing period, forms, comments and CDN the
 * calendar month. One date for all of them was wrong for half of them.
 */
function resetLabel(category: UsageCategory): string | null {
  if (category.resetsAt === null) return t('billing.usage_level_note')
  if (!category.resetsAt) return null
  return t('billing.usage_resets_on', { date: formatDate(category.resetsAt) })
}

/** The price of a unit past the limit, shown before the switch is turned on. */
function unitPriceLabel(category: UsageCategory): string | null {
  const pricing = OVERAGE_PRICING[category.limitKey]
  if (!category.overageUnitPrice || !pricing) return null
  return t('billing.overage_unit_price', { price: `$${category.overageUnitPrice}`, unit: pricing.unit })
}

/** The switch is described by its price and, when locked, by why. */
function describedBy(category: UsageCategory): string | undefined {
  const ids = [
    unitPriceLabel(category) ? `overage-price-${category.key}` : null,
    category.overageLock ? `overage-lock-${category.key}` : null,
  ].filter(Boolean)
  return ids.length ? ids.join(' ') : undefined
}

/** What to say when a meter is at its limit and nothing extra is billed. */
function limitReachedText(category: UsageCategory): string {
  if (!canManage.value) return t('billing.limit_reached_member', { name: category.name })
  if (category.overageSellable === false || category.overageLock) return t('billing.limit_reached_fixed', { name: category.name })
  return t('billing.limit_reached_manage', { name: category.name })
}

/** Icon per category */
function categoryIcon(key: string): string {
  switch (key) {
    case 'ai_messages': return 'icon-[annon--comment-dots]'
    case 'form_submissions': return 'icon-[annon--file-text]'
    case 'comments': return 'icon-[annon--comments]'
    case 'cdn_bandwidth': return 'icon-[annon--globe]'
    case 'media_storage': return 'icon-[annon--image]'
    case 'api_messages': return 'icon-[annon--code]'
    default: return 'icon-[annon--chart-bar]'
  }
}
</script>

<template>
  <div class="space-y-4">
    <!-- Section header -->
    <div class="flex items-center justify-between">
      <h3 class="text-sm font-medium text-heading dark:text-secondary-100">
        {{ t('billing.usage_title') }}
      </h3>
    </div>

    <!-- Members see the meters; say who can change them. -->
    <p v-if="usage && !canManage" class="rounded-md bg-secondary-50 px-3 py-2 text-xs text-muted dark:bg-secondary-900">
      {{ t('billing.usage_member_note') }}
    </p>

    <!-- Loading state -->
    <div v-if="loading && !usage" class="flex items-center justify-center py-8">
      <span class="icon-[annon--loader] size-5 animate-spin text-muted" />
    </div>

    <!-- Usage meters -->
    <div v-else-if="usage" class="space-y-3">
      <div
        v-for="category in usage.categories"
        :key="category.key"
        class="rounded-lg border border-secondary-200 p-4 dark:border-secondary-800"
      >
        <div class="mb-3 flex items-center justify-between">
          <div class="flex items-center gap-2">
            <span :class="categoryIcon(category.key)" class="size-4 text-muted" aria-hidden="true" />
            <span class="text-sm font-medium text-heading dark:text-secondary-100">
              {{ category.name }}
            </span>
          </div>

          <!-- Overage toggle. Absent where extra usage is not sold at
               all: offering a switch that cannot take effect is worse
               than saying the limit is fixed. -->
          <span
            v-if="category.overageSellable === false"
            class="text-xs text-muted"
            :title="t('billing.overage_not_available')"
          >
            {{ t('billing.overage_hard_limit') }}
          </span>
          <div v-else-if="canManage && category.limit !== -1 && category.limit > 0" class="flex flex-col items-end gap-1">
            <AtomsFormSwitch
              :model-value="category.overageEnabled"
              :disabled="!canToggleOverage || togglingKey !== null || !!category.overageLock"
              :label="t('billing.allow_overage')"
              :described-by="describedBy(category)"
              @update:model-value="handleToggle(category.key, $event)"
            />
            <!-- The price per unit past the limit, before anyone turns it on. -->
            <span
              v-if="unitPriceLabel(category)"
              :id="`overage-price-${category.key}`"
              class="text-right text-xs text-muted tabular-nums"
            >
              {{ unitPriceLabel(category) }}
            </span>
            <!-- Why the switch is off and when it can be on. The plan's
                 included usage is unaffected either way. -->
            <span
              v-if="category.overageLock"
              :id="`overage-lock-${category.key}`"
              class="text-right text-xs text-muted"
            >
              {{ overageLockText(category.overageLock) }}
            </span>
          </div>
          <span v-else-if="category.limit === -1" class="text-xs text-success-600 dark:text-success-400">
            {{ t('billing.usage_unlimited') }}
          </span>
        </div>

        <AtomsUsageMeter
          :current="category.current"
          :limit="category.limit"
          :unit="category.unit"
          :overage-enabled="category.overageEnabled"
          :overage-units="category.overageUnits"
          :overage-unit-price="category.overageUnitPrice"
        />

        <p v-if="resetLabel(category)" class="mt-1 text-xs text-muted">
          {{ resetLabel(category) }}
        </p>

        <p
          v-if="category.key === 'ai_messages' && (usage.byoaRequests ?? 0) > 0"
          class="mt-2 text-xs text-muted"
        >
          {{ t('billing.usage_byoa_requests', { count: usage.byoaRequests ?? 0 }) }}
        </p>

        <!-- Limit reached warning (overage disabled) -->
        <div
          v-if="category.percentage >= 100 && !category.overageEnabled && category.limit > 0"
          class="mt-2 rounded-md bg-danger-50 px-3 py-2 dark:bg-danger-950/30"
        >
          <p class="text-xs text-danger-700 dark:text-danger-300">
            {{ limitReachedText(category) }}
          </p>
        </div>

        <!-- Approaching limit warning -->
        <div
          v-else-if="category.percentage >= 80 && category.percentage < 100"
          class="mt-2 rounded-md bg-warning-50 px-3 py-2 dark:bg-warning-950/30"
        >
          <p class="text-xs text-warning-700 dark:text-warning-300">
            {{ category.percentage }}% {{ t('billing.usage_percentage') }}
          </p>
        </div>
      </div>
    </div>

    <!-- Overage summary -->
    <div
      v-if="usage && canManage && (usage.totalOverageAmount > 0 || usage.projectedOverageAmount > 0)"
      class="rounded-lg border border-secondary-200 bg-secondary-50 p-4 dark:border-secondary-800 dark:bg-secondary-900"
    >
      <div class="space-y-2">
        <div v-if="usage.totalOverageAmount > 0" class="flex items-center justify-between text-sm">
          <span class="text-heading dark:text-secondary-100">
            {{ t('billing.total_overage') }}
          </span>
          <span class="font-medium tabular-nums text-danger-600 dark:text-danger-400">
            ${{ usage.totalOverageAmount.toFixed(2) }}
          </span>
        </div>
        <div v-if="usage.projectedOverageAmount > 0" class="flex items-center justify-between text-sm">
          <span class="text-muted">
            {{ t('billing.projected_overage') }}
          </span>
          <span class="tabular-nums text-muted">
            ~${{ usage.projectedOverageAmount.toFixed(2) }}
          </span>
        </div>
      </div>
    </div>

    <!-- No overages -->
    <div
      v-else-if="usage && canManage"
      class="rounded-lg border border-dashed border-secondary-200 px-4 py-3 text-center dark:border-secondary-800"
    >
      <p class="text-xs text-muted">
        {{ t('billing.no_overage') }}
      </p>
    </div>
  </div>
</template>

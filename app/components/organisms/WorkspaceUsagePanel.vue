<script setup lang="ts">
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

function formatMonth(period: string): string {
  const [year, month] = period.split('-')
  const date = new Date(Number(year), Number(month) - 1)
  return date.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
}

/** Icon per category */
function categoryIcon(key: string): string {
  switch (key) {
    case 'ai_messages': return 'icon-[annon--comment-dots]'
    case 'form_submissions': return 'icon-[annon--file-text]'
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
      <span v-if="usage" class="text-xs text-muted">
        {{ formatMonth(usage.billingPeriod) }}
      </span>
    </div>

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

          <!-- Overage toggle -->
          <div v-if="category.limit !== -1 && category.limit > 0">
            <AtomsFormSwitch
              :model-value="category.overageEnabled"
              :disabled="!canToggleOverage || togglingKey !== null"
              :label="t('billing.allow_overage')"
              @update:model-value="handleToggle(category.key, $event)"
            />
          </div>
          <span v-else class="text-xs text-success-600 dark:text-success-400">
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

        <!-- Limit reached warning (overage disabled) -->
        <div
          v-if="category.percentage >= 100 && !category.overageEnabled && category.limit > 0"
          class="mt-2 rounded-md bg-danger-50 px-3 py-2 dark:bg-danger-950/30"
        >
          <p class="text-xs text-danger-700 dark:text-danger-300">
            {{ t('billing.overage_disabled') }} — {{ category.name }} {{ t('billing.limit_reached') }}
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
      v-if="usage && (usage.totalOverageAmount > 0 || usage.projectedOverageAmount > 0)"
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
      v-else-if="usage"
      class="rounded-lg border border-dashed border-secondary-200 px-4 py-3 text-center dark:border-secondary-800"
    >
      <p class="text-xs text-muted">
        {{ t('billing.no_overage') }}
      </p>
    </div>
  </div>
</template>

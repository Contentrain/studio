<script setup lang="ts">
const props = defineProps<{
  current: number
  limit: number
  unit: string
  overageEnabled?: boolean
  overageUnits?: number
  overageUnitPrice?: number
}>()

const isUnlimited = computed(() => props.limit === -1)

const percentage = computed(() => {
  if (isUnlimited.value || props.limit === 0) return 0
  return Math.min((props.current / props.limit) * 100, 100)
})

const overagePercentage = computed(() => {
  if (!props.overageEnabled || isUnlimited.value || props.limit === 0) return 0
  if (props.current <= props.limit) return 0
  // Scale overage visually: each 50% overage = 10% of bar width beyond 100%
  const overageRatio = (props.current - props.limit) / props.limit
  return Math.min(overageRatio * 20, 30) // Cap at 30% additional width
})

const barColor = computed(() => {
  if (isUnlimited.value) return 'bg-primary-500'
  if (percentage.value >= 100) return 'bg-danger-500'
  if (percentage.value >= 80) return 'bg-warning-500'
  return 'bg-primary-500'
})

function formatValue(value: number, unit: string): string {
  if (unit === 'GB' || unit === 'GB/month') {
    return value >= 1 ? `${value.toFixed(1)} GB` : `${Math.round(value * 1024)} MB`
  }
  return `${Math.round(value)}`
}

function formatLimit(limit: number, unit: string): string {
  if (limit === -1) return 'Unlimited'
  if (unit === 'GB' || unit === 'GB/month') {
    return `${limit} GB`
  }
  return `${limit}`
}
</script>

<template>
  <div>
    <!-- Value display -->
    <div class="mb-1.5 flex items-baseline justify-between text-sm">
      <span class="tabular-nums text-heading dark:text-secondary-100">
        {{ formatValue(current, unit) }}
      </span>
      <span class="text-muted">
        / {{ formatLimit(limit, unit) }} {{ !isUnlimited ? unit : '' }}
      </span>
    </div>

    <!-- Progress bar -->
    <div class="relative h-2 w-full overflow-hidden rounded-full bg-secondary-200 dark:bg-secondary-700">
      <!-- Base usage bar -->
      <div
        class="h-full rounded-full transition-all duration-500 ease-out"
        :class="barColor"
        :style="{ width: `${isUnlimited ? 0 : percentage}%` }"
      />

      <!-- Overage extension (red zone past 100%) -->
      <div
        v-if="overagePercentage > 0"
        class="absolute top-0 h-full rounded-r-full bg-danger-400/60 transition-all duration-500"
        :style="{ left: '100%', width: `${overagePercentage}%`, marginLeft: '-1px' }"
      />
    </div>

    <!-- Percentage / overage info -->
    <div class="mt-1 flex items-center justify-between text-xs">
      <span v-if="!isUnlimited && limit > 0" class="text-muted tabular-nums">
        {{ Math.round((current / limit) * 100) }}%
      </span>
      <span v-if="(overageUnits ?? 0) > 0" class="text-danger-600 dark:text-danger-400 tabular-nums">
        +{{ formatValue(overageUnits ?? 0, unit) }} overage
        <span v-if="overageUnitPrice">({{ '$' + ((overageUnits ?? 0) * overageUnitPrice).toFixed(2) }})</span>
      </span>
    </div>
  </div>
</template>

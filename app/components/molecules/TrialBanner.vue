<script setup lang="ts">
const { t } = useContent()

const props = defineProps<{
  trialEndsAt: string | null
}>()

const emit = defineEmits<{
  choosePlan: []
}>()

const daysLeft = computed(() => {
  if (!props.trialEndsAt) return null
  const now = new Date()
  const end = new Date(props.trialEndsAt)
  const diff = end.getTime() - now.getTime()
  if (diff <= 0) return 0
  return Math.ceil(diff / (1000 * 60 * 60 * 24))
})

const isExpired = computed(() => daysLeft.value !== null && daysLeft.value <= 0)
const isUrgent = computed(() => daysLeft.value !== null && daysLeft.value <= 3 && daysLeft.value > 0)

const bannerText = computed(() => {
  if (isExpired.value) return t('trial.expired_text')
  if (daysLeft.value === 1) return t('trial.banner_last_day')
  return t('trial.banner_text', { days: daysLeft.value ?? 0 })
})
</script>

<template>
  <div
    v-if="daysLeft !== null"
    class="flex items-center justify-between px-4 py-2 text-sm"
    :class="[
      isExpired
        ? 'bg-danger-50 text-danger-700 dark:bg-danger-950 dark:text-danger-300'
        : isUrgent
          ? 'bg-warning-50 text-warning-700 dark:bg-warning-950 dark:text-warning-300'
          : 'bg-primary-50 text-primary-700 dark:bg-primary-950 dark:text-primary-300',
    ]"
  >
    <div class="flex items-center gap-2">
      <span
        class="size-4"
        :class="isExpired ? 'icon-[annon--alert-triangle]' : 'icon-[annon--clock]'"
        aria-hidden="true"
      />
      <span>{{ bannerText }}</span>
    </div>

    <button
      type="button"
      class="rounded-md px-3 py-1 text-xs font-medium transition-colors"
      :class="[
        isExpired
          ? 'bg-danger-600 text-white hover:bg-danger-700'
          : 'bg-primary-600 text-white hover:bg-primary-700',
      ]"
      @click="emit('choosePlan')"
    >
      {{ t('trial.choose_plan') }}
    </button>
  </div>
</template>

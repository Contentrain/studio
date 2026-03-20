<script setup lang="ts">
const props = defineProps<{
  name: string
  input: unknown
  result?: unknown
  status: 'pending' | 'streaming' | 'complete' | 'error'
}>()

const isExpanded = ref(false)

const statusIcon = computed(() => {
  switch (props.status) {
    case 'pending':
    case 'streaming':
      return null // spinner
    case 'complete':
      return 'icon-[annon--check-circle]'
    case 'error':
      return 'icon-[annon--alert-circle]'
    default:
      return null
  }
})
</script>

<template>
  <div class="rounded-lg border border-secondary-200 bg-secondary-50 dark:border-secondary-800 dark:bg-secondary-900">
    <!-- Header -->
    <button
      type="button"
      class="flex w-full items-center gap-2 px-3 py-2 text-left text-xs font-medium transition-colors hover:bg-secondary-100 focus-visible:outline-none dark:hover:bg-secondary-800"
      @click="isExpanded = !isExpanded"
    >
      <!-- Status -->
      <div
        v-if="status === 'pending' || status === 'streaming'"
        class="size-3.5 animate-spin rounded-full border-2 border-secondary-300 border-t-primary-500 dark:border-secondary-600 dark:border-t-primary-400"
      />
      <span
        v-else-if="statusIcon" :class="[statusIcon, status === 'complete' ? 'text-success-500' : 'text-danger-500']"
        class="size-3.5" aria-hidden="true"
      />

      <span class="icon-[annon--gear] size-3.5 text-muted" aria-hidden="true" />
      <span class="flex-1 text-heading dark:text-secondary-100">{{ name }}</span>
      <span
        class="icon-[annon--chevron-down] size-3 text-muted transition-transform"
        :class="isExpanded ? 'rotate-180' : ''" aria-hidden="true"
      />
    </button>

    <!-- Expanded content -->
    <div v-if="isExpanded" class="border-t border-secondary-200 px-3 py-2 dark:border-secondary-800">
      <!-- Input -->
      <div v-if="input" class="mb-2">
        <AtomsSectionLabel label="Input" class="px-0 py-0" />
        <pre
          class="mt-1 max-h-32 overflow-auto rounded bg-white p-2 font-mono text-[11px] text-body dark:bg-secondary-950 dark:text-secondary-300"
        >{{ JSON.stringify(input, null, 2) }}</pre>
      </div>

      <!-- Result -->
      <div v-if="result">
        <AtomsSectionLabel label="Result" class="px-0 py-0" />
        <pre
          class="mt-1 max-h-32 overflow-auto rounded bg-white p-2 font-mono text-[11px] text-body dark:bg-secondary-950 dark:text-secondary-300"
        >{{ JSON.stringify(result, null, 2) }}</pre>
      </div>
    </div>
  </div>
</template>

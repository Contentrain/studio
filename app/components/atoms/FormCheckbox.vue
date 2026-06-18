<script setup lang="ts">
defineProps<{
  /** This checkbox's value within the bound array. */
  value: string
  label: string
}>()

/** Bound to a `string[]` — Vue adds/removes `value` as it's toggled. */
const model = defineModel<string[]>({ required: true })

const id = useId()
</script>

<template>
  <label
    :for="id"
    class="inline-flex cursor-pointer items-center gap-1.5 text-xs text-body dark:text-secondary-300"
  >
    <input
      :id="id"
      v-model="model"
      type="checkbox"
      :value="value"
      class="size-3.5 cursor-pointer rounded border-secondary-300 accent-primary-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50 dark:border-secondary-600"
    >
    {{ label }}
  </label>
</template>

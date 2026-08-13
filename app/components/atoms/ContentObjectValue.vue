<script lang="ts" setup>
/**
 * A structured value (object or array) rendered as a collapsible JSON block.
 *
 * Shared by both branches of ContentFieldDisplay that can hold one. They used
 * to stringify it inline with different truncation rules, and that asymmetry
 * was the overflow bug — a single component makes them impossible to drift.
 */
// `object` rather than a union: a `|` inside a template expression is parsed
// as a Vue 2 filter, so the call sites could not cast to a union type.
const props = defineProps<{
  value: object
}>()

const { t } = useContent()

const isArray = computed(() => Array.isArray(props.value))
const count = computed(() =>
  Array.isArray(props.value) ? props.value.length : Object.keys(props.value).length,
)
const summary = computed(() =>
  isArray.value
    ? t('content.array_item_count', { count: count.value })
    : t('content.object_field_count', { count: count.value }),
)
const formatted = computed(() => JSON.stringify(props.value, null, 2))
</script>

<template>
  <details class="group/object min-w-0">
    <!-- `flex` also drops the native disclosure triangle, matching the
         chevron pattern used by the entry rows and the sidebar. -->
    <summary
      class="flex items-center justify-end gap-1 rounded text-xs text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50"
    >
      <span
        class="icon-[annon--chevron-right] size-3 shrink-0 transition-transform group-open/object:rotate-90"
        aria-hidden="true"
      />
      <span class="truncate">{{ summary }}</span>
    </summary>

    <!-- Wrap, never scroll: a horizontal scrollbar inside a 320px panel is a
         worse answer than a taller block. `break-all` is deliberate — JSON
         has long unbroken runs with no spaces to wrap at. -->
    <pre class="mt-1 whitespace-pre-wrap break-all rounded bg-secondary-50 p-2 text-left font-mono text-[11px] leading-relaxed text-body dark:bg-secondary-800 dark:text-secondary-300">{{ formatted }}</pre>
  </details>
</template>

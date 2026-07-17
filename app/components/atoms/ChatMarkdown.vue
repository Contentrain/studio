<script setup lang="ts">
import { marked } from 'marked'

const props = defineProps<{
  text: string
}>()

const { sanitize } = useSanitize()

// Markdown parsing + sanitize runs over the FULL accumulated text. While
// a segment streams, `text` grows by a token on every delta, so
// re-parsing on each change is O(n²) and makes long messages janky.
// Throttle the source that feeds the parser to ~12fps, with a guaranteed
// trailing run so the final text always renders in full. Finished
// segments never change, so only the trailing streaming segment pays
// the reparse cost.
const PARSE_THROTTLE_MS = 80
const parseSource = ref(props.text)
let lastParsedAt = 0
let trailing: ReturnType<typeof setTimeout> | null = null

watch(() => props.text, (val) => {
  if (trailing) {
    clearTimeout(trailing)
    trailing = null
  }
  const elapsed = Date.now() - lastParsedAt
  if (elapsed >= PARSE_THROTTLE_MS) {
    lastParsedAt = Date.now()
    parseSource.value = val
  }
  else {
    trailing = setTimeout(() => {
      lastParsedAt = Date.now()
      parseSource.value = props.text
      trailing = null
    }, PARSE_THROTTLE_MS - elapsed)
  }
}, { immediate: true })

onBeforeUnmount(() => {
  if (trailing) clearTimeout(trailing)
})

const renderedHtml = computed(() => {
  if (!parseSource.value) return ''
  return sanitize(marked.parse(parseSource.value, { async: false }) as string)
})
</script>

<template>
  <div
    class="prose prose-sm max-w-none dark:prose-invert [&>*:first-child]:mt-0 [&>*:last-child]:mb-0"
    v-html="renderedHtml"
  />
</template>

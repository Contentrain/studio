<script setup lang="ts">
import { marked } from 'marked'

const props = defineProps<{
  role: 'user' | 'assistant'
  text: string
}>()

const { sanitize } = useSanitize()

const renderedHtml = computed(() => {
  if (!props.text) return ''
  if (props.role === 'user') return props.text
  return sanitize(marked.parse(props.text, { async: false }) as string)
})
</script>

<template>
  <div class="flex gap-3" :class="role === 'user' ? 'flex-row-reverse' : ''">
    <!-- Avatar -->
    <div class="shrink-0 pt-0.5">
      <div
        class="flex size-7 items-center justify-center rounded-full text-xs font-bold" :class="role === 'user'
          ? 'bg-primary-100 text-primary-700 dark:bg-primary-900/30 dark:text-primary-400'
          : 'bg-secondary-100 text-secondary-600 dark:bg-secondary-800 dark:text-secondary-300'
        "
      >
        {{ role === 'user' ? 'U' : 'AI' }}
      </div>
    </div>

    <!-- Content -->
    <div
      class="min-w-0 max-w-[85%] rounded-2xl px-4 py-2.5 text-sm" :class="role === 'user'
        ? 'bg-primary-600 text-white dark:bg-primary-500'
        : 'bg-secondary-50 text-heading dark:bg-secondary-900 dark:text-secondary-100'
      "
    >
      <!-- User: plain text -->
      <p v-if="role === 'user'" class="whitespace-pre-wrap">
        {{ text }}
      </p>

      <!-- Assistant: rendered markdown -->
      <div
        v-else class="prose prose-sm max-w-none dark:prose-invert [&>*:first-child]:mt-0 [&>*:last-child]:mb-0"
        v-html="renderedHtml"
      />
    </div>
  </div>
</template>

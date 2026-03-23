<script setup lang="ts">
import { marked } from 'marked'

const props = defineProps<{
  role: 'user' | 'assistant'
  text: string
  userAvatarUrl?: string | null
  userName?: string | null
  /** Context items attached to this message */
  contextItems?: ReadonlyArray<{ readonly type: string, readonly label: string, readonly sublabel?: string }>
}>()

const { sanitize } = useSanitize()

const renderedHtml = computed(() => {
  if (!props.text) return ''
  if (props.role === 'user') return props.text
  return sanitize(marked.parse(props.text, { async: false }) as string)
})

const contextTypeIcons: Record<string, string> = {
  model: 'icon-[annon--layers]',
  entry: 'icon-[annon--file-text]',
  field: 'icon-[annon--code]',
}
</script>

<template>
  <div class="flex gap-3" :class="role === 'user' ? 'flex-row-reverse' : ''">
    <!-- Avatar -->
    <div class="shrink-0 pt-0.5">
      <!-- User: real avatar -->
      <AtomsAvatar
        v-if="role === 'user'"
        :src="userAvatarUrl"
        :name="userName"
        size="sm"
      />
      <!-- AI: Contentrain logo -->
      <div v-else class="flex size-7 items-center justify-center rounded-full bg-secondary-100 dark:bg-secondary-800">
        <AtomsLogo variant="icon" color="auto" class="size-4" />
      </div>
    </div>

    <!-- Content -->
    <div class="min-w-0 max-w-[85%]">
      <!-- Attached context chips (user messages only) -->
      <div v-if="contextItems && contextItems.length > 0" class="mb-1 flex flex-wrap gap-1" :class="role === 'user' ? 'justify-end' : ''">
        <span
          v-for="(item, idx) in contextItems"
          :key="idx"
          class="inline-flex items-center gap-1 rounded-md bg-secondary-100 px-1.5 py-0.5 text-[10px] font-medium text-muted dark:bg-secondary-800"
        >
          <span :class="contextTypeIcons[item.type] ?? 'icon-[annon--code]'" class="size-2.5" aria-hidden="true" />
          <span class="truncate">{{ item.label }}</span>
          <span v-if="item.sublabel" class="truncate opacity-60">· {{ item.sublabel }}</span>
        </span>
      </div>

      <div
        class="rounded-2xl px-4 py-2.5 text-sm" :class="role === 'user'
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
  </div>
</template>

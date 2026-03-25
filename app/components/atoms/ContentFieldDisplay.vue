<script setup lang="ts">
import { marked } from 'marked'

const { sanitize } = useSanitize()

/**
 * Renders a content field value based on its type.
 * Read-only display — not an editor.
 * Maps to schema-architecture.md type catalog.
 */
const props = defineProps<{
  type: string
  value: unknown
  fieldId: string
  options?: string[]
}>()

const displayValue = computed(() => {
  if (props.value === null || props.value === undefined) return null
  return props.value
})

const isUrl = computed(() => ['url', 'image', 'video', 'file'].includes(props.type))
const isEmail = computed(() => props.type === 'email')
const isPhone = computed(() => props.type === 'phone')
const isBoolean = computed(() => props.type === 'boolean')
const isColor = computed(() => props.type === 'color')
const isDate = computed(() => ['date', 'datetime'].includes(props.type))
const isSelect = computed(() => props.type === 'select')
const isRating = computed(() => props.type === 'rating')
const isNumber = computed(() => ['number', 'integer', 'decimal', 'percent'].includes(props.type))
const isArray = computed(() => props.type === 'array' || Array.isArray(props.value))
const isObject = computed(() => typeof props.value === 'object' && props.value !== null && !Array.isArray(props.value) && !isColor.value && !isDate.value)
const isRichText = computed(() => ['markdown', 'richtext', 'text', 'code'].includes(props.type))
const isImage = computed(() => props.type === 'image')

const formattedDate = computed(() => {
  if (!isDate.value || !displayValue.value) return ''
  const d = new Date(String(displayValue.value))
  if (Number.isNaN(d.getTime())) return String(displayValue.value)
  return props.type === 'date'
    ? d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
    : d.toLocaleString('en-US', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
})

const ratingStars = computed(() => {
  const n = Number(displayValue.value) || 0
  return { filled: Math.min(n, 5), empty: Math.max(5 - n, 0) }
})
</script>

<template>
  <div class="min-w-0">
    <!-- Null / empty -->
    <span v-if="displayValue === null" class="text-xs italic text-disabled">—</span>

    <!-- Boolean -->
    <div v-else-if="isBoolean" class="flex items-center">
      <div
        class="size-4 rounded-full border-2"
        :class="displayValue
          ? 'border-success-500 bg-success-500'
          : 'border-secondary-300 dark:border-secondary-600'
        "
      >
        <span v-if="displayValue" class="icon-[annon--check] block size-full text-white" aria-hidden="true" />
      </div>
      <span class="ml-2 text-xs text-muted">{{ displayValue ? 'Yes' : 'No' }}</span>
    </div>

    <!-- Color swatch -->
    <div v-else-if="isColor" class="flex items-center gap-2">
      <div
        class="size-5 rounded border border-secondary-200 dark:border-secondary-700"
        :style="{ backgroundColor: String(displayValue) }"
      />
      <span class="font-mono text-xs text-muted">{{ displayValue }}</span>
    </div>

    <!-- Rating -->
    <div v-else-if="isRating" class="flex items-center gap-0.5">
      <span v-for="i in ratingStars.filled" :key="`f${i}`" class="text-warning-400">★</span>
      <span v-for="i in ratingStars.empty" :key="`e${i}`" class="text-secondary-200 dark:text-secondary-700">★</span>
    </div>

    <!-- Select -->
    <AtomsBadge v-else-if="isSelect" variant="secondary" size="sm">
      {{ displayValue }}
    </AtomsBadge>

    <!-- Date -->
    <span v-else-if="isDate" class="text-sm text-heading dark:text-secondary-100">
      {{ formattedDate }}
    </span>

    <!-- Image thumbnail -->
    <div v-else-if="isImage && displayValue" class="flex items-center gap-2">
      <div class="size-8 shrink-0 overflow-hidden rounded border border-secondary-200 bg-secondary-50 dark:border-secondary-700 dark:bg-secondary-800">
        <NuxtImg
          v-if="String(displayValue).startsWith('media/')"
          :src="String(displayValue)"
          :alt="String(displayValue).split('/').pop() ?? ''"
          class="size-full object-cover"
          loading="lazy"
        />
        <span v-else class="icon-[annon--image] block size-full p-1.5 text-muted" aria-hidden="true" />
      </div>
      <span class="truncate text-xs text-muted">{{ String(displayValue).split('/').pop() }}</span>
    </div>

    <!-- URL -->
    <span v-else-if="isUrl" class="truncate text-sm text-primary-500 dark:text-primary-400">
      {{ String(displayValue) }}
    </span>

    <!-- Email -->
    <span v-else-if="isEmail" class="text-sm text-primary-500 dark:text-primary-400">
      {{ displayValue }}
    </span>

    <!-- Phone -->
    <span v-else-if="isPhone" class="font-mono text-sm text-heading dark:text-secondary-100">
      {{ displayValue }}
    </span>

    <!-- Number / Percent -->
    <span v-else-if="isNumber" class="font-mono text-sm text-heading dark:text-secondary-100">
      {{ displayValue }}{{ props.type === 'percent' ? '%' : '' }}
    </span>

    <!-- Array of primitives (tags) -->
    <div v-else-if="isArray && Array.isArray(displayValue) && displayValue.length > 0 && typeof displayValue[0] !== 'object'" class="flex flex-wrap gap-1">
      <AtomsBadge v-for="(item, i) in (displayValue as unknown[]).slice(0, 8)" :key="i" variant="secondary" size="sm">
        {{ String(item) }}
      </AtomsBadge>
      <AtomsBadge v-if="(displayValue as unknown[]).length > 8" variant="secondary" size="sm">
        +{{ (displayValue as unknown[]).length - 8 }}
      </AtomsBadge>
    </div>

    <!-- Array of objects -->
    <div v-else-if="isArray && Array.isArray(displayValue) && displayValue.length > 0 && typeof displayValue[0] === 'object'" class="space-y-1.5">
      <div
        v-for="(item, i) in (displayValue as Record<string, unknown>[]).slice(0, 5)"
        :key="i"
        class="rounded-lg border border-secondary-200 p-2 dark:border-secondary-800"
      >
        <div v-for="(val, key) in item" :key="String(key)" class="flex items-start gap-2 py-0.5">
          <span class="shrink-0 text-[10px] font-medium uppercase tracking-wider text-muted">{{ String(key) }}</span>
          <span class="ml-auto max-w-[60%] truncate text-right text-xs text-heading dark:text-secondary-100">
            {{ typeof val === 'object' ? JSON.stringify(val) : String(val) }}
          </span>
        </div>
      </div>
      <span v-if="(displayValue as unknown[]).length > 5" class="text-xs text-muted">
        +{{ (displayValue as unknown[]).length - 5 }} more
      </span>
    </div>

    <!-- Markdown preview -->
    <div
      v-else-if="props.type === 'markdown'"
      class="prose prose-sm prose-secondary max-w-none dark:prose-invert [&>*:first-child]:mt-0 [&>*:last-child]:mb-0"
      v-html="sanitize(marked.parse(String(displayValue).substring(0, 500), { async: false }) as string)"
    />

    <!-- Richtext (HTML) preview -->
    <div
      v-else-if="props.type === 'richtext'"
      class="prose prose-sm prose-secondary max-w-none dark:prose-invert [&>*:first-child]:mt-0 [&>*:last-child]:mb-0"
      v-html="sanitize(String(displayValue).substring(0, 500))"
    />

    <!-- Long text (plain) -->
    <p v-else-if="isRichText" class="line-clamp-3 text-sm text-body dark:text-secondary-300">
      {{ String(displayValue).substring(0, 200) }}
    </p>

    <!-- Nested object (e.g. frontmatter hero: { title, subtitle }) -->
    <div v-else-if="isObject" class="space-y-1 rounded-lg border border-secondary-200 p-2.5 dark:border-secondary-800">
      <div v-for="(val, key) in (displayValue as Record<string, unknown>)" :key="String(key)" class="flex items-start gap-2 py-0.5">
        <span class="shrink-0 text-[10px] font-medium uppercase tracking-wider text-muted">{{ String(key) }}</span>
        <span class="ml-auto max-w-[60%] text-right text-xs text-heading dark:text-secondary-100" :class="typeof val === 'string' && val.length > 50 ? 'truncate' : ''">
          {{ typeof val === 'object' ? JSON.stringify(val) : String(val) }}
        </span>
      </div>
    </div>

    <!-- Default: string / unknown -->
    <span v-else class="text-sm text-heading dark:text-secondary-100">
      {{ String(displayValue) }}
    </span>
  </div>
</template>

<script setup lang="ts">
import { marked } from 'marked'

const { sanitize } = useSanitize()
const { t } = useContent()

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

// `image`, `video` and `file` used to sit in here too, which meant video and
// file fell through to the URL branch and printed as raw text. They render as
// media now (below), so this covers plain `url` only.
const isUrl = computed(() => props.type === 'url')
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

const isVideo = computed(() => props.type === 'video')
const isFile = computed(() => props.type === 'file')
const isMedia = computed(() => isImage.value || isVideo.value || isFile.value)

/**
 * Three outcomes have to stay apart, because two of them used to look identical:
 * a stored asset that loads, a stored asset that 404s (an error — the file
 * should be there), and a value that was never a stored asset at all (an
 * external URL, a project-specific reference). The third is not broken, and
 * showing it as a broken thumbnail is what made editors report "media is
 * corrupt" for values Studio never held.
 */
const isStoredAsset = computed(() => isStoredAssetPath(String(displayValue.value ?? '')))

const route = useRoute()
// A media field value is either a relative storage path (`media/...`, resolved
// to the public CDN delivery URL on the same origin) or an already-absolute URL
// (used as-is). Either way it renders without extra integration.
const mediaSrc = computed(() => {
  const v = String(displayValue.value ?? '')
  if (isStoredAsset.value) {
    const projectId = route.params.projectId
    return projectId ? `/api/cdn/v1/${projectId}/${v}` : v
  }
  return v
})

// Only ask the browser for something it could actually fetch. A custom
// reference is reported as-is rather than turned into a pointless 404.
const canRenderMedia = computed(() => canRenderMediaValue(String(displayValue.value ?? '')))

// A new value has not failed yet — without this, one broken asset would keep
// the error state for every row the component is reused for.
const mediaFailed = ref(false)
watch(() => props.value, () => {
  mediaFailed.value = false
})

const mediaName = computed(() => readableMediaName(String(displayValue.value ?? '')))

// Hover opens the preview on its own; this is bound so a tap can open it too,
// on a device where hover does not exist.
const previewOpen = ref(false)

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
      <span class="ml-2 text-xs text-muted">{{ displayValue ? t('common.yes') : t('common.no') }}</span>
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

    <!-- Media: image / video / file. The row keeps its 32px tile — list density
         is unchanged — and the full-size look lives behind hover or a tap. -->
    <div v-else-if="isMedia && displayValue" class="flex min-w-0 items-center gap-2">
      <!-- Renders, and can be previewed. The large variant is only requested
           once the tooltip opens, because Radix mounts the content then. -->
      <AtomsTooltip
        v-if="!isFile && canRenderMedia && !mediaFailed"
        v-model:open="previewOpen"
        variant="panel"
        side="right"
        disable-closing-trigger
      >
        <button
          type="button"
          :aria-label="t('content.media_preview')"
          class="size-8 shrink-0 overflow-hidden rounded border border-secondary-200 bg-secondary-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50 dark:border-secondary-700 dark:bg-secondary-800"
          @click="previewOpen = !previewOpen"
        >
          <NuxtImg
            v-if="!isVideo"
            :src="mediaSrc"
            :alt="mediaName"
            class="size-full object-cover"
            loading="lazy"
            @error="mediaFailed = true"
          />
          <span v-else class="icon-[annon--play-circle] block size-full p-1.5 text-muted" aria-hidden="true" />
        </button>
        <template #content>
          <video v-if="isVideo" :src="mediaSrc" controls preload="metadata" class="max-h-64 max-w-72 rounded" @error="mediaFailed = true" />
          <NuxtImg
            v-else
            :src="mediaSrc"
            :alt="mediaName"
            class="max-h-64 max-w-72 rounded object-contain"
            @error="mediaFailed = true"
          />
        </template>
      </AtomsTooltip>

      <!-- A `file` has nothing to preview, and neither does a value that failed
           or was never ours — each gets a tile that says which it is. -->
      <div
        v-else
        class="flex size-8 shrink-0 items-center justify-center rounded border"
        :class="mediaFailed && isStoredAsset
          ? 'border-danger-200 bg-danger-50 dark:border-danger-800 dark:bg-danger-900/30'
          : 'border-secondary-200 bg-secondary-50 dark:border-secondary-700 dark:bg-secondary-800'"
      >
        <span
          class="size-4"
          :class="mediaFailed && isStoredAsset
            ? 'icon-[annon--alert-triangle] text-danger-500'
            : isFile ? 'icon-[annon--file-text] text-muted' : 'icon-[annon--image] text-muted'"
          aria-hidden="true"
        />
      </div>

      <div class="min-w-0">
        <div class="truncate text-xs text-muted">
          {{ mediaName }}
        </div>
        <!-- Only says something when there is something to say: a stored asset
             that would not load is an error; a value that was never stored is
             not, and used to be indistinguishable from one. -->
        <div v-if="mediaFailed && isStoredAsset" class="truncate text-[10px] text-danger-500">
          {{ t('content.media_missing') }}
        </div>
        <div v-else-if="!canRenderMedia" class="truncate text-[10px] text-muted">
          {{ t('content.media_external') }}
        </div>
      </div>
    </div>

    <!-- URL. `block` is load-bearing: overflow does not apply to inline
         non-replaced boxes, so `truncate` on a bare span did nothing and a
         long URL ran straight out of the panel. -->
    <span v-else-if="isUrl" class="block truncate text-sm text-primary-500 dark:text-primary-400">
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
    <span v-else-if="isNumber" class="font-mono text-sm tabular-nums text-heading dark:text-secondary-100">
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
        <div v-for="(val, key) in item" :key="String(key)" class="flex min-w-0 items-start gap-2 py-0.5">
          <span class="shrink-0 text-[10px] font-medium uppercase tracking-wider text-muted">{{ String(key) }}</span>
          <AtomsContentObjectValue
            v-if="val !== null && typeof val === 'object'"
            :value="val as object"
            class="ml-auto max-w-[60%]"
          />
          <span v-else class="ml-auto min-w-0 max-w-[60%] truncate text-right text-xs text-heading dark:text-secondary-100">
            {{ String(val) }}
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
      <div v-for="(val, key) in (displayValue as Record<string, unknown>)" :key="String(key)" class="flex min-w-0 items-start gap-2 py-0.5">
        <span class="shrink-0 text-[10px] font-medium uppercase tracking-wider text-muted">{{ String(key) }}</span>
        <AtomsContentObjectValue
          v-if="val !== null && typeof val === 'object'"
          :value="val as object"
          class="ml-auto max-w-[60%]"
        />
        <span v-else class="ml-auto min-w-0 max-w-[60%] truncate text-right text-xs text-heading dark:text-secondary-100">
          {{ String(val) }}
        </span>
      </div>
    </div>

    <!-- Default: string / unknown. `slug`, `icon` and plain `string` land here
         (isRichText only covers markdown/richtext/text/code), so a long
         unbroken value — a token, a base64 blob — used to run out of the
         panel. Wrap rather than truncate: these are readable values. -->
    <span v-else class="block break-words text-sm text-heading dark:text-secondary-100">
      {{ String(displayValue) }}
    </span>
  </div>
</template>

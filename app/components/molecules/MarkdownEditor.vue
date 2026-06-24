<script setup lang="ts">
import { marked } from 'marked'

/**
 * Source-mode Markdown editor — toolbar + live preview over a plain
 * textarea. Deliberately NOT a WYSIWYG: the raw markdown the user (or the
 * chat agent) writes is preserved byte-for-byte, so round-trips never
 * reformat content. Preview reuses the same `marked` + DOMPurify pipeline
 * as the rest of the app.
 */
const {
  modelValue,
  placeholder = '',
  disabled = false,
  minRows = 12,
} = defineProps<{
  modelValue: string
  placeholder?: string
  disabled?: boolean
  minRows?: number
}>()

const emit = defineEmits<{ 'update:modelValue': [value: string] }>()

const { t } = useContent()
const { sanitize } = useSanitize()

type View = 'edit' | 'preview' | 'split'
const view = ref<View>('edit')
const textareaRef = ref<HTMLTextAreaElement>()

const rendered = computed(() =>
  modelValue.trim() ? sanitize(marked.parse(modelValue, { async: false }) as string) : '',
)

function applyValue(next: string, selStart: number, selEnd: number) {
  emit('update:modelValue', next)
  nextTick(() => {
    const ta = textareaRef.value
    if (!ta) return
    ta.focus()
    ta.setSelectionRange(selStart, selEnd)
  })
}

/** Wrap the selection in `prefix … suffix`; cursor lands inside when empty. */
function wrap(prefix: string, suffix = prefix) {
  const ta = textareaRef.value
  if (!ta) return
  const s = ta.selectionStart
  const e = ta.selectionEnd
  const sel = modelValue.slice(s, e)
  applyValue(
    modelValue.slice(0, s) + prefix + sel + suffix + modelValue.slice(e),
    s + prefix.length,
    s + prefix.length + sel.length,
  )
}

/** Prefix every line touched by the selection (headings, lists, quote). */
function prefixLines(prefix: string) {
  const ta = textareaRef.value
  if (!ta) return
  const s = ta.selectionStart
  const e = ta.selectionEnd
  const lineStart = modelValue.lastIndexOf('\n', s - 1) + 1
  const block = modelValue.slice(lineStart, e)
  const replaced = block.split('\n').map(l => prefix + l).join('\n')
  applyValue(
    modelValue.slice(0, lineStart) + replaced + modelValue.slice(e),
    lineStart,
    lineStart + replaced.length,
  )
}

/** Insert `[text](url)` / `![alt](url)`, selecting the `url` placeholder. */
function insertLink(image = false) {
  const ta = textareaRef.value
  if (!ta) return
  const s = ta.selectionStart
  const e = ta.selectionEnd
  const label = modelValue.slice(s, e) || (image ? 'alt' : 'text')
  const snippet = `${image ? '!' : ''}[${label}](url)`
  const urlStart = s + (image ? 1 : 0) + 1 + label.length + 2
  applyValue(modelValue.slice(0, s) + snippet + modelValue.slice(e), urlStart, urlStart + 3)
}

/** Insert a block on its own line, placing the cursor at `cursorOffset`. */
function insertBlock(text: string, cursorOffset: number) {
  const ta = textareaRef.value
  if (!ta) return
  const s = ta.selectionStart
  const lead = s > 0 && modelValue[s - 1] !== '\n' ? '\n' : ''
  const block = lead + text
  const pos = s + lead.length + cursorOffset
  applyValue(modelValue.slice(0, s) + block + modelValue.slice(s), pos, pos)
}

const CODE_BLOCK = '```\n\n```\n'
const TABLE = '| Column | Column |\n| --- | --- |\n| Cell | Cell |\n'

const VIEWS: Array<{ id: View, label: string }> = [
  { id: 'edit', label: 'editor.view_edit' },
  { id: 'preview', label: 'editor.view_preview' },
  { id: 'split', label: 'editor.view_split' },
]

const TOOL_CLASS = 'flex h-7 min-w-7 items-center justify-center rounded text-muted transition-colors hover:bg-secondary-200 hover:text-heading focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50 dark:hover:bg-secondary-700 dark:hover:text-secondary-100'
</script>

<template>
  <div class="flex flex-col overflow-hidden rounded-lg border border-secondary-200 dark:border-secondary-800">
    <!-- Toolbar -->
    <div
      class="flex flex-wrap items-center gap-0.5 border-b border-secondary-200 bg-secondary-50 px-1.5 py-1 dark:border-secondary-800 dark:bg-secondary-900"
    >
      <template v-if="view !== 'preview' && !disabled">
        <button type="button" :title="t('editor.bold')" :class="TOOL_CLASS" @click="wrap('**')">
          <span class="icon-[annon--text-bold] size-4" aria-hidden="true" />
        </button>
        <button type="button" :title="t('editor.italic')" :class="TOOL_CLASS" @click="wrap('*')">
          <span class="icon-[annon--text-italic] size-4" aria-hidden="true" />
        </button>
        <button type="button" :title="t('editor.inline_code')" :class="TOOL_CLASS" @click="wrap('`')">
          <span class="icon-[annon--code] size-4" aria-hidden="true" />
        </button>

        <span class="mx-1 h-4 w-px bg-secondary-200 dark:bg-secondary-700" aria-hidden="true" />

        <button
          type="button" :title="t('editor.heading_1')" :class="[TOOL_CLASS, 'px-1.5 text-xs font-semibold']"
          @click="prefixLines('# ')"
        >
          H1
        </button>
        <button
          type="button" :title="t('editor.heading_2')" :class="[TOOL_CLASS, 'px-1.5 text-xs font-semibold']"
          @click="prefixLines('## ')"
        >
          H2
        </button>
        <button
          type="button" :title="t('editor.heading_3')" :class="[TOOL_CLASS, 'px-1.5 text-xs font-semibold']"
          @click="prefixLines('### ')"
        >
          H3
        </button>

        <span class="mx-1 h-4 w-px bg-secondary-200 dark:bg-secondary-700" aria-hidden="true" />

        <button type="button" :title="t('editor.bullet_list')" :class="TOOL_CLASS" @click="prefixLines('- ')">
          <span class="icon-[annon--list-unordered] size-4" aria-hidden="true" />
        </button>
        <button type="button" :title="t('editor.numbered_list')" :class="TOOL_CLASS" @click="prefixLines('1. ')">
          <span class="icon-[annon--list-ordered] size-4" aria-hidden="true" />
        </button>
        <button type="button" :title="t('editor.quote')" :class="TOOL_CLASS" @click="prefixLines('> ')">
          <span class="icon-[annon--quotes] size-4" aria-hidden="true" />
        </button>
        <button type="button" :title="t('editor.code_block')" :class="TOOL_CLASS" @click="insertBlock(CODE_BLOCK, 4)">
          <span class="icon-[annon--terminal] size-4" aria-hidden="true" />
        </button>

        <span class="mx-1 h-4 w-px bg-secondary-200 dark:bg-secondary-700" aria-hidden="true" />

        <button type="button" :title="t('editor.link')" :class="TOOL_CLASS" @click="insertLink(false)">
          <span class="icon-[annon--link-1] size-4" aria-hidden="true" />
        </button>
        <button type="button" :title="t('editor.image')" :class="TOOL_CLASS" @click="insertLink(true)">
          <span class="icon-[annon--image] size-4" aria-hidden="true" />
        </button>
        <button
          type="button" :title="t('editor.table')" :class="[TOOL_CLASS, 'px-1.5 text-xs font-medium']"
          @click="insertBlock(TABLE, TABLE.length)"
        >
          {{ t('editor.table') }}
        </button>
      </template>

      <div class="flex-1" />

      <!-- View toggle -->
      <div class="flex items-center gap-0.5 rounded-md bg-secondary-100 p-0.5 dark:bg-secondary-800">
        <button
          v-for="v in VIEWS" :key="v.id" type="button"
          class="rounded px-2 py-0.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50"
          :class="view === v.id
            ? 'bg-white text-heading shadow-sm dark:bg-secondary-950 dark:text-secondary-100'
            : 'text-muted hover:text-heading dark:hover:text-secondary-100'" @click="view = v.id"
        >
          {{ t(v.label) }}
        </button>
      </div>
    </div>

    <!-- Body -->
    <div
      class="flex min-h-0"
      :class="view === 'split' ? 'divide-x divide-secondary-200 dark:divide-secondary-800' : ''"
    >
      <textarea
        v-if="view !== 'preview'" ref="textareaRef" :value="modelValue" :placeholder="placeholder"
        :disabled="disabled" :rows="minRows"
        class="w-full resize-y bg-white px-3 py-2 font-mono text-[13px] leading-relaxed text-secondary-900 placeholder:text-muted focus:outline-none disabled:cursor-not-allowed disabled:opacity-50 dark:bg-secondary-950 dark:text-secondary-100"
        :class="view === 'split' ? 'w-1/2' : ''"
        @input="emit('update:modelValue', ($event.target as HTMLTextAreaElement).value)"
      />
      <div
        v-if="view !== 'edit'"
        class="prose prose-sm prose-secondary max-w-none overflow-y-auto bg-white px-3 py-2 dark:prose-invert dark:bg-secondary-950"
        :class="view === 'split' ? 'w-1/2' : 'w-full'"
      >
        <div v-if="rendered" v-html="rendered" />
        <p v-else class="text-sm text-muted">
          {{ t('editor.preview_empty') }}
        </p>
      </div>
    </div>
  </div>
</template>

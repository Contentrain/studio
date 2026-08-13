<script setup lang="ts">
const props = defineProps<{
  terms: [string, Record<string, string>][]
  locale: string
  editable?: boolean
}>()

const emit = defineEmits<{
  save: [terms: Record<string, Record<string, string> | null>]
}>()

const { t } = useContent()

const vocabNewKey = ref('')
const vocabNewValue = ref('')
const keyInputRef = ref<HTMLInputElement | null>(null)

function deleteTerm(key: string) {
  emit('save', { [key]: null })
}

function addTerm() {
  const key = vocabNewKey.value.trim()
  const value = vocabNewValue.value.trim()
  if (!key || !value) return
  emit('save', { [key]: { [props.locale]: value } })
  vocabNewKey.value = ''
  vocabNewValue.value = ''
  // Terms are entered in runs, and submitting left focus on the button — so
  // every term after the first needed a trip back to the mouse.
  keyInputRef.value?.focus()
}

// ── Bulk add ───────────────────────────────────────────────
// A glossary arrives as a list, not as one term at a time. Paste is the whole
// feature: a file picker with mapping and preview would be a much larger
// surface for the same outcome.
const bulkOpen = ref(false)
const bulkText = ref('')
const bulkInputRef = ref<HTMLTextAreaElement | null>(null)

/**
 * One term per line, key and translation split at the first tab — which is what
 * a spreadsheet paste gives you — falling back to the first run of whitespace
 * so a hand-typed list works too. Values keep any later tabs and spaces.
 */
const bulkParsed = computed(() => {
  const terms: Record<string, string> = {}
  for (const line of bulkText.value.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const match = /^(\S+?)[\t\s]+(.+)$/.exec(trimmed)
    if (!match) continue
    const [, key, value] = match
    if (key && value?.trim()) terms[key] = value.trim()
  }
  return terms
})

const bulkCount = computed(() => Object.keys(bulkParsed.value).length)

function openBulk() {
  bulkOpen.value = true
  nextTick(() => bulkInputRef.value?.focus())
}

function cancelBulk() {
  bulkOpen.value = false
  bulkText.value = ''
}

function submitBulk() {
  if (bulkCount.value === 0) return
  // One emit, not one per term: the save endpoint takes the whole record, and
  // emitting per term would open a branch and a merge for each of them.
  const payload: Record<string, Record<string, string>> = {}
  for (const [key, value] of Object.entries(bulkParsed.value)) {
    payload[key] = { [props.locale]: value }
  }
  emit('save', payload)
  cancelBulk()
}
</script>

<template>
  <div v-if="terms.length === 0 && !editable" class="p-5">
    <AtomsEmptyState
      icon="icon-[annon--book-library]"
      :title="t('content.vocabulary_empty_title')"
      :description="t('content.vocabulary_empty_description')"
    />
  </div>
  <template v-else>
    <div class="divide-y divide-secondary-100 dark:divide-secondary-800">
      <div
        v-for="[term, translations] in terms"
        :key="term"
        class="group/row flex items-center gap-3 px-5 py-2.5 hover:bg-secondary-50 dark:hover:bg-secondary-900"
      >
        <div class="min-w-0 flex-1">
          <div class="font-mono text-xs font-medium text-label">
            {{ term }}
          </div>
          <div class="mt-0.5 text-sm text-heading dark:text-secondary-100">
            {{ translations[locale] ?? (Object.keys(translations).length > 0 ? translations[Object.keys(translations)[0]!] : '—') }}
          </div>
          <div v-if="Object.keys(translations).length > 1" class="mt-0.5 flex gap-1.5">
            <span
              v-for="(_val, loc) in translations"
              :key="loc"
              class="text-[10px] text-muted"
              :class="{ 'font-medium text-primary-500': loc === locale }"
            >
              {{ String(loc).toUpperCase() }}
            </span>
          </div>
        </div>
        <AtomsTooltip v-if="editable" :text="t('vocabulary.delete_term')">
          <button
            type="button"
            :aria-label="t('vocabulary.delete_term')"
            class="reveal-on-hover shrink-0 rounded p-1 text-muted transition-[color,opacity] hover:text-danger-500 group-hover/row:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50"
            @click="deleteTerm(term)"
          >
            <span class="icon-[annon--trash] block size-3.5" aria-hidden="true" />
          </button>
        </AtomsTooltip>
      </div>
    </div>
    <!-- Add term -->
    <div v-if="editable" class="sticky bottom-0 border-t border-secondary-200 bg-white px-5 py-3 dark:border-secondary-800 dark:bg-secondary-950">
      <!-- `min-w-0` on the value input and `shrink-0` on the button: a flex item
           defaults to `min-width: auto`, so the input refused to shrink below a
           text field's intrinsic width and pushed the submit button out of the
           panel — easier to hit now that the panel is resizable down to 280px. -->
      <form v-if="!bulkOpen" class="flex items-center gap-2" @submit.prevent="addTerm">
        <input
          ref="keyInputRef"
          v-model="vocabNewKey"
          type="text"
          :placeholder="t('vocabulary.key_placeholder')"
          class="h-8 w-24 shrink-0 rounded-lg border border-secondary-200 bg-white px-2.5 text-xs font-mono text-heading placeholder:text-disabled focus:outline-none focus:ring-2 focus:ring-primary-500/50 dark:border-secondary-700 dark:bg-secondary-900 dark:text-secondary-100"
        >
        <input
          v-model="vocabNewValue"
          type="text"
          :placeholder="t('vocabulary.value_placeholder')"
          class="h-8 min-w-0 flex-1 rounded-lg border border-secondary-200 bg-white px-2.5 text-sm text-heading placeholder:text-disabled focus:outline-none focus:ring-2 focus:ring-primary-500/50 dark:border-secondary-700 dark:bg-secondary-900 dark:text-secondary-100"
        >
        <AtomsBaseButton
          type="submit"
          variant="primary"
          size="sm"
          class="shrink-0"
          :disabled="!vocabNewKey.trim() || !vocabNewValue.trim()"
        >
          <span class="icon-[annon--plus] size-3.5" aria-hidden="true" />
        </AtomsBaseButton>
        <button
          type="button"
          class="shrink-0 rounded px-1.5 py-1 text-xs font-medium text-muted transition-colors hover:text-body focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50 dark:hover:text-secondary-100"
          @click="openBulk"
        >
          {{ t('vocabulary.bulk_add') }}
        </button>
      </form>

      <!-- Bulk paste -->
      <form v-else class="space-y-2" @submit.prevent="submitBulk">
        <textarea
          ref="bulkInputRef"
          v-model="bulkText"
          rows="5"
          :placeholder="t('vocabulary.bulk_placeholder')"
          class="w-full resize-y rounded-lg border border-secondary-200 bg-white px-2.5 py-2 font-mono text-xs text-heading placeholder:text-disabled focus:outline-none focus:ring-2 focus:ring-primary-500/50 dark:border-secondary-700 dark:bg-secondary-900 dark:text-secondary-100"
        />
        <p class="text-xs text-muted">
          {{ t('vocabulary.bulk_hint', { locale: locale.toUpperCase() }) }}
        </p>
        <div class="flex items-center gap-2">
          <span class="min-w-0 flex-1 truncate text-xs text-label">
            {{ t('vocabulary.bulk_count', { count: bulkCount }) }}
          </span>
          <AtomsBaseButton type="button" variant="ghost" size="sm" class="shrink-0" @click="cancelBulk">
            {{ t('common.cancel') }}
          </AtomsBaseButton>
          <AtomsBaseButton type="submit" variant="primary" size="sm" class="shrink-0" :disabled="bulkCount === 0">
            {{ t('common.add') }}
          </AtomsBaseButton>
        </div>
      </form>
    </div>
  </template>
</template>

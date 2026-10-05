<script setup lang="ts">
import { ComboboxAnchor, ComboboxContent, ComboboxGroup, ComboboxInput, ComboboxItem, ComboboxLabel, ComboboxPortal, ComboboxRoot, ComboboxTrigger, ComboboxViewport } from 'radix-vue'
import type { RelationPickerOption } from '~~/shared/utils/relation-search'
import { filterRelationOptions, groupRelationOptions, relationOptionRef } from '~~/shared/utils/relation-search'

/**
 * Searchable select — type to narrow a long list, pick with arrows + Enter.
 *
 * Built on the Radix Vue Combobox (ARIA combobox on the input, listbox popup,
 * roving highlight, Esc to close). Filtering is ours, not Radix's: it ignores
 * case and diacritics, and matches the id/slug as well as the label. Only the
 * first `maxResults` matches are drawn, so a collection of thousands stays
 * smooth; a note says how many more there are and asks for more typing.
 *
 * `clearOnSelect` is the "add" flavour: the value is handed to the parent and
 * the box empties, ready for the next pick (the parent keeps the chosen ones).
 */
const {
  modelValue = '',
  options,
  placeholder = '',
  label = undefined,
  loading = false,
  clearOnSelect = false,
  maxResults = 100,
} = defineProps<{
  modelValue?: string
  options: readonly RelationPickerOption[]
  placeholder?: string
  /** Accessible name of the input. */
  label?: string
  /** The options are still on their way. */
  loading?: boolean
  clearOnSelect?: boolean
  maxResults?: number
}>()

const emit = defineEmits<{
  'update:modelValue': [value: string]
}>()

const { t } = useContent()

const open = ref(false)
const searchTerm = ref('')

const result = computed(() => filterRelationOptions(options, searchTerm.value, maxResults))
const groups = computed(() => groupRelationOptions(result.value.items))
// Polymorphic matches carry their model: show it even when only one model matches.
const grouped = computed(() => result.value.items.some(item => item.group))
const searching = computed(() => searchTerm.value.trim().length > 0)

function selectedText(value: string): string {
  if (!value || clearOnSelect) return ''
  const option = options.find(o => o.value === value)
  return option ? (option.text ?? option.label) : ''
}

function onSelect(value: unknown) {
  if (typeof value !== 'string' || !value) return
  emit('update:modelValue', value)
  open.value = false
  if (clearOnSelect) searchTerm.value = ''
}

// A click or focus on the box opens the list; the chevron toggles it.
function openList() {
  if (!loading) open.value = true
}
</script>

<template>
  <ComboboxRoot
    :model-value="modelValue"
    :open="open"
    :search-term="searchTerm"
    :display-value="selectedText"
    :filter-function="(values: any) => values"
    :reset-search-term-on-select="true"
    @update:model-value="onSelect"
    @update:open="open = $event"
    @update:search-term="searchTerm = $event"
  >
    <ComboboxAnchor
      class="flex h-9 w-full items-center gap-1.5 rounded-lg border border-secondary-200 bg-white px-3 text-sm text-heading transition-colors focus-within:ring-2 focus-within:ring-primary-500/50 dark:border-secondary-700 dark:bg-secondary-800 dark:text-secondary-100"
    >
      <ComboboxInput
        :placeholder="placeholder"
        :aria-label="label ?? t('content.relation_search_label')"
        :aria-busy="loading || undefined"
        autocomplete="off"
        class="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted"
        @focus="openList"
        @click="openList"
      />
      <AtomsSpinner v-if="loading" size="sm" class="shrink-0" />
      <ComboboxTrigger
        v-else
        :aria-label="t('content.relation_toggle_list')"
        class="shrink-0 rounded text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50"
      >
        <span class="icon-[annon--chevron-down] size-3" aria-hidden="true" />
      </ComboboxTrigger>
    </ComboboxAnchor>

    <ComboboxPortal>
      <ComboboxContent
        position="popper" :side-offset="4"
        class="z-50 max-h-72 min-w-(--radix-popper-anchor-width) overflow-hidden rounded-lg border border-secondary-200 bg-white shadow-lg dark:border-secondary-800 dark:bg-secondary-950"
      >
        <ComboboxViewport class="max-h-72 overflow-y-auto p-1">
          <p v-if="loading" class="px-2 py-3 text-sm text-muted" role="status">
            {{ t('content.relation_loading') }}
          </p>
          <p v-else-if="options.length === 0" class="px-2 py-3 text-sm text-muted" role="status">
            {{ t('content.relation_none_available') }}
          </p>
          <p v-else-if="result.total === 0" class="px-2 py-3 text-sm text-muted" role="status">
            {{ t('content.relation_no_results', { query: searchTerm.trim() }) }}
          </p>
          <template v-else>
            <ComboboxGroup v-for="group in groups" :key="group.key">
              <ComboboxLabel
                v-if="grouped"
                class="px-2 pb-0.5 pt-1.5 text-xs font-semibold uppercase tracking-wide text-muted"
              >
                {{ group.label }}
              </ComboboxLabel>
              <ComboboxItem
                v-for="opt in group.items" :key="opt.value" :value="opt.value"
                class="flex items-baseline justify-between gap-3 rounded-md px-2 py-1.5 text-sm text-heading outline-none transition-colors data-highlighted:bg-secondary-50 dark:text-secondary-100 dark:data-highlighted:bg-secondary-900"
              >
                <span class="min-w-0 truncate">{{ opt.text ?? opt.label }}</span>
                <span v-if="searching" class="max-w-[40%] shrink-0 truncate font-mono text-xs text-muted">{{ relationOptionRef(opt) }}</span>
              </ComboboxItem>
            </ComboboxGroup>
            <p v-if="result.total > result.items.length" class="px-2 pb-1 pt-2 text-xs text-muted" role="status">
              {{ t('content.relation_truncated', { shown: result.items.length, total: result.total }) }}
            </p>
          </template>
        </ComboboxViewport>
      </ComboboxContent>
    </ComboboxPortal>
  </ComboboxRoot>
</template>

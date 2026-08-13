<script setup lang="ts">
import { PopoverContent, PopoverPortal, PopoverRoot, PopoverTrigger } from 'radix-vue'
import type { FilterAxis, FilterSelection, SortOption } from '~/utils/content-filters'

/**
 * Filter and sort controls for a collection listing.
 *
 * One button opening a popover, with the active filters shown as chips —
 * rather than a row of dropdowns. The number of axes is derived from the model
 * and so varies from one to many, and the panel is 280–640px wide: a fixed row
 * of controls would overflow on some models and look empty on others. A single
 * button costs the same whatever the model, and the chips keep "what is being
 * filtered" visible without needing the room.
 */
const props = defineProps<{
  axes: readonly FilterAxis[]
  sortOptions: readonly SortOption[]
  activeCount: number
}>()

const { t } = useContent()

const selection = defineModel<FilterSelection>('selection', { required: true })
const sort = defineModel<string>('sort', { required: true })

const open = ref(false)

function isSelected(axisId: string, value: string) {
  return selection.value[axisId]?.includes(value) ?? false
}

function toggle(axisId: string, value: string) {
  const current = selection.value[axisId] ?? []
  const next = current.includes(value)
    ? current.filter(v => v !== value)
    : [...current, value]

  // Rebuilt without the key rather than emptied: "no values selected" and "axis
  // not filtered" are the same thing, and keeping both spellings around is how
  // an active-filter count goes wrong.
  const updated = Object.fromEntries(
    Object.entries(selection.value).filter(([key]) => key !== axisId),
  )
  if (next.length > 0) updated[axisId] = next
  selection.value = updated
}

function clearAll() {
  selection.value = {}
}

/** Flattened for the chip row: one chip per selected value, not per axis. */
const activeChips = computed(() =>
  props.axes.flatMap(axis =>
    (selection.value[axis.id] ?? []).map(value => ({
      axisId: axis.id,
      value,
      label: axis.options.find(o => o.value === value)?.label ?? value,
    })),
  ),
)
</script>

<template>
  <div class="space-y-2">
    <div class="flex items-center gap-2">
      <PopoverRoot v-model:open="open">
        <PopoverTrigger as-child>
          <button
            type="button"
            class="flex h-7 shrink-0 items-center gap-1.5 rounded-lg border border-secondary-200 px-2 text-xs font-medium text-body transition-colors hover:bg-secondary-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50 dark:border-secondary-700 dark:text-secondary-300 dark:hover:bg-secondary-900"
          >
            <span class="icon-[annon--filter] size-3.5" aria-hidden="true" />
            {{ t('content.filter') }}
            <AtomsBadge v-if="activeCount > 0" variant="primary" size="sm">
              {{ activeCount }}
            </AtomsBadge>
          </button>
        </PopoverTrigger>
        <PopoverPortal>
          <PopoverContent
            side="bottom"
            align="start"
            :side-offset="6"
            :collision-padding="8"
            class="z-50 max-h-[70vh] w-64 overflow-y-auto rounded-lg border border-secondary-200 bg-white p-3 shadow-lg dark:border-secondary-700 dark:bg-secondary-900"
          >
            <div v-for="axis in axes" :key="axis.id" class="mb-3 last:mb-0">
              <p class="mb-1 text-[10px] font-medium uppercase tracking-wider text-muted">
                {{ axis.label }}
              </p>
              <div class="space-y-0.5">
                <button
                  v-for="option in axis.options"
                  :key="option.value"
                  type="button"
                  :aria-pressed="isSelected(axis.id, option.value)"
                  class="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-xs transition-colors hover:bg-secondary-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50 dark:hover:bg-secondary-800"
                  :class="isSelected(axis.id, option.value)
                    ? 'text-heading dark:text-secondary-100'
                    : 'text-body dark:text-secondary-300'"
                  @click="toggle(axis.id, option.value)"
                >
                  <span
                    class="size-3.5 shrink-0"
                    :class="isSelected(axis.id, option.value)
                      ? 'icon-[annon--check-circle] text-primary-500'
                      : 'icon-[annon--radio] text-disabled'"
                    aria-hidden="true"
                  />
                  <span class="min-w-0 flex-1 truncate">{{ option.label }}</span>
                </button>
              </div>
            </div>

            <p v-if="axes.length === 0" class="text-xs text-muted">
              {{ t('content.filter_none') }}
            </p>
          </PopoverContent>
        </PopoverPortal>
      </PopoverRoot>

      <!-- Sort. A plain select: one choice from a list, and it has to survive a
           280px panel. -->
      <AtomsFormSelect
        v-model="sort"
        size="sm"
        class="min-w-0 flex-1"
        :label="t('content.sort')"
        :options="[...sortOptions]"
      />
    </div>

    <!-- Active filters. Removable one at a time, because the alternative is
         reopening the popover to find which value did the narrowing. -->
    <div v-if="activeChips.length > 0" class="flex flex-wrap items-center gap-1">
      <button
        v-for="chip in activeChips"
        :key="`${chip.axisId}:${chip.value}`"
        type="button"
        class="flex max-w-full items-center gap-1 rounded-full bg-primary-50 py-0.5 pl-2 pr-1 text-[11px] text-primary-600 transition-colors hover:bg-primary-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50 dark:bg-primary-500/15 dark:text-primary-300"
        :aria-label="t('content.filter_remove', { value: chip.label })"
        @click="toggle(chip.axisId, chip.value)"
      >
        <span class="min-w-0 truncate">{{ chip.label }}</span>
        <span class="icon-[annon--cross] size-3 shrink-0" aria-hidden="true" />
      </button>
      <button
        type="button"
        class="rounded px-1.5 py-0.5 text-[11px] font-medium text-muted transition-colors hover:text-body focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50 dark:hover:text-secondary-100"
        @click="clearAll"
      >
        {{ t('common.clear_all') }}
      </button>
    </div>
  </div>
</template>

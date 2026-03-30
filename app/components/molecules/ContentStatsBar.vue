<script setup lang="ts">
import { TooltipArrow, TooltipContent, TooltipPortal, TooltipProvider, TooltipRoot, TooltipTrigger } from 'radix-vue'

defineProps<{
  modelCount: number
  entryCount: number
  locales: readonly string[]
  healthScore: number
}>()

const emit = defineEmits<{
  viewHealth: []
}>()

const { t } = useContent()
</script>

<template>
  <TooltipProvider :delay-duration="300">
    <div class="flex items-center gap-3 border-b border-secondary-100 px-5 py-2.5 dark:border-secondary-800/50">
      <!-- Models -->
      <TooltipRoot>
        <TooltipTrigger as-child>
          <div class="flex items-center gap-1.5 text-xs text-muted">
            <span class="icon-[annon--layers] size-3.5" aria-hidden="true" />
            <span class="font-medium">{{ modelCount }}</span>
          </div>
        </TooltipTrigger>
        <TooltipPortal>
          <TooltipContent
            :side-offset="6"
            class="z-50 rounded-lg bg-secondary-900 px-2.5 py-1.5 text-xs text-white shadow-lg dark:bg-secondary-100 dark:text-secondary-900"
          >
            {{ modelCount }} {{ modelCount === 1 ? 'model' : 'models' }}
            <TooltipArrow class="fill-secondary-900 dark:fill-secondary-100" />
          </TooltipContent>
        </TooltipPortal>
      </TooltipRoot>

      <!-- Entries -->
      <TooltipRoot>
        <TooltipTrigger as-child>
          <div class="flex items-center gap-1.5 text-xs text-muted">
            <span class="icon-[annon--file-text] size-3.5" aria-hidden="true" />
            <span class="font-medium">{{ entryCount }}</span>
          </div>
        </TooltipTrigger>
        <TooltipPortal>
          <TooltipContent
            :side-offset="6"
            class="z-50 rounded-lg bg-secondary-900 px-2.5 py-1.5 text-xs text-white shadow-lg dark:bg-secondary-100 dark:text-secondary-900"
          >
            {{ entryCount }} {{ entryCount === 1 ? 'entry' : 'entries' }}
            <TooltipArrow class="fill-secondary-900 dark:fill-secondary-100" />
          </TooltipContent>
        </TooltipPortal>
      </TooltipRoot>

      <!-- Locales -->
      <TooltipRoot v-if="locales.length > 0">
        <TooltipTrigger as-child>
          <div class="flex items-center gap-1.5 text-xs text-muted">
            <span class="icon-[annon--globe] size-3.5" aria-hidden="true" />
            <span class="font-medium">{{ locales.map(l => l.toUpperCase()).join(', ') }}</span>
          </div>
        </TooltipTrigger>
        <TooltipPortal>
          <TooltipContent
            :side-offset="6"
            class="z-50 rounded-lg bg-secondary-900 px-2.5 py-1.5 text-xs text-white shadow-lg dark:bg-secondary-100 dark:text-secondary-900"
          >
            {{ locales.length }} {{ locales.length === 1 ? 'locale' : 'locales' }}: {{ locales.join(', ') }}
            <TooltipArrow class="fill-secondary-900 dark:fill-secondary-100" />
          </TooltipContent>
        </TooltipPortal>
      </TooltipRoot>

      <!-- Health score -->
      <TooltipRoot>
        <TooltipTrigger as-child>
          <button type="button" class="ml-auto" @click="emit('viewHealth')">
            <AtomsHealthScoreBadge :score="healthScore" size="sm" />
          </button>
        </TooltipTrigger>
        <TooltipPortal>
          <TooltipContent
            :side-offset="6"
            class="z-50 rounded-lg bg-secondary-900 px-2.5 py-1.5 text-xs text-white shadow-lg dark:bg-secondary-100 dark:text-secondary-900"
          >
            {{ t('health.score_label') }}: {{ healthScore }}/100
            <TooltipArrow class="fill-secondary-900 dark:fill-secondary-100" />
          </TooltipContent>
        </TooltipPortal>
      </TooltipRoot>
    </div>
  </TooltipProvider>
</template>

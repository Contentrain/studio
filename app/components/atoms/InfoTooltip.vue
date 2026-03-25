<script setup lang="ts">
import { TooltipArrow, TooltipContent, TooltipPortal, TooltipProvider, TooltipRoot, TooltipTrigger } from 'radix-vue'

defineProps<{
  text: string
}>()
</script>

<template>
  <TooltipProvider :delay-duration="200">
    <TooltipRoot>
      <TooltipTrigger as-child>
        <button
          type="button"
          class="inline-flex shrink-0 rounded-full p-0.5 text-muted transition-colors hover:text-label focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50"
        >
          <span class="icon-[annon--info] size-3.5" aria-hidden="true" />
        </button>
      </TooltipTrigger>
      <TooltipPortal>
        <TooltipContent
          :side-offset="6"
          side="top"
          class="z-50 max-w-64 rounded-lg border border-secondary-200 bg-white px-3 py-2 text-xs leading-relaxed text-body shadow-lg dark:border-secondary-700 dark:bg-secondary-800 dark:text-secondary-200"
        >
          {{ text }}
          <TooltipArrow class="fill-white dark:fill-secondary-800" />
        </TooltipContent>
      </TooltipPortal>
    </TooltipRoot>
  </TooltipProvider>
</template>

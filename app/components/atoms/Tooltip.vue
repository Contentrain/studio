<script setup lang="ts">
import { TooltipArrow, TooltipContent, TooltipPortal, TooltipProvider, TooltipRoot, TooltipTrigger } from 'radix-vue'

/**
 * Tooltip that wraps whatever you give it. `InfoTooltip` owns its own button and
 * can therefore only ever be an info icon; this takes the trigger as a slot, so
 * an action button keeps being an action button.
 *
 * The provider is inside the atom rather than at the app root because
 * `TooltipRoot` throws without one — mounting a component on its own in a test,
 * or rendering outside the layout, would break. The cost is Radix's
 * cross-tooltip `skipDelayDuration`: the delay is paid per trigger. That is what
 * the two hand-rolled stacks already did, so nothing regresses; hoisting the
 * provider later is a one-line change here.
 */
withDefaults(defineProps<{
  /** Tooltip text. Ignored when the `content` slot is used. */
  text?: string
  side?: 'top' | 'right' | 'bottom' | 'left'
  sideOffset?: number
  /** `panel` drops the text padding so a slot can fill the surface (media preview). */
  variant?: 'text' | 'panel'
  disabled?: boolean
  /**
   * Keep the tooltip open when its trigger is clicked. Needed when the trigger
   * doubles as the tap target on a device with no hover, where Radix's own
   * close-on-click would immediately undo the tap that opened it.
   */
  disableClosingTrigger?: boolean
  delayDuration?: number
}>(), {
  side: 'top',
  sideOffset: 6,
  variant: 'text',
  delayDuration: 200,
})

/**
 * Undefined leaves Radix uncontrolled (hover and focus only). Binding it hands
 * control to the caller — hover still writes through, so a caller only has to
 * add whatever extra way of opening it needs.
 */
const open = defineModel<boolean | undefined>('open', { default: undefined })
</script>

<template>
  <TooltipProvider :delay-duration="delayDuration">
    <TooltipRoot
      v-model:open="open"
      :disabled="disabled"
      :disable-closing-trigger="disableClosingTrigger"
    >
      <TooltipTrigger as-child>
        <slot />
      </TooltipTrigger>
      <TooltipPortal>
        <TooltipContent
          :side="side"
          :side-offset="sideOffset"
          :collision-padding="8"
          class="z-50 rounded-lg border border-secondary-200 bg-white text-xs leading-relaxed text-body shadow-lg dark:border-secondary-700 dark:bg-secondary-800 dark:text-secondary-200"
          :class="variant === 'panel' ? 'overflow-hidden p-1' : 'max-w-64 px-3 py-2'"
        >
          <slot name="content">
            {{ text }}
          </slot>
          <TooltipArrow class="fill-white dark:fill-secondary-800" />
        </TooltipContent>
      </TooltipPortal>
    </TooltipRoot>
  </TooltipProvider>
</template>

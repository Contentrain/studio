<script setup lang="ts">
import { TooltipProvider } from 'radix-vue'
import { tooltipProviderKey } from '~/utils/injection-keys'

/**
 * The app's single tooltip provider, and the flag that says so.
 *
 * The two live in one component on purpose. `AtomsTooltip` needs to know
 * whether a provider is above it — Radix exports no way to ask — and a flag
 * provided without the provider it describes makes every tooltip throw. Binding
 * them together means they cannot be separated by a later edit.
 *
 * Hoisting matters because Radix's `skipDelayDuration` only applies within one
 * provider. With a provider per tooltip it never applied at all: scanning the
 * three action icons on a row re-paid the open delay each time, and that scan is
 * what the tooltips were added for.
 */
provide(tooltipProviderKey, true)
</script>

<template>
  <TooltipProvider :delay-duration="TOOLTIP_DELAY_MS" :skip-delay-duration="TOOLTIP_SKIP_DELAY_MS">
    <slot />
  </TooltipProvider>
</template>

<script lang="ts" setup>
import { Label } from 'radix-vue'

interface Props {
  for?: string
  text?: string
  required?: boolean
  optional?: boolean
  size?: 'xs' | 'sm' | 'md'
  bold?: boolean
}

withDefaults(defineProps<Props>(), {
  required: false,
  optional: false,
  size: 'sm',
  bold: false,
})
</script>

<template>
  <Label
    :for="$props.for"
    class="inline-flex items-center gap-1 text-label"
    :class="[
      {
        'text-xs': size === 'xs',
        'text-sm': size === 'sm',
        'text-base': size === 'md',
      },
      bold ? 'font-medium' : 'font-normal',
    ]"
  >
    <span v-if="text">{{ text }}</span>
    <slot v-else />
    <span v-if="required" class="text-danger-500" aria-hidden="true">*</span>
    <span v-if="optional" class="text-muted text-xs">(optional)</span>
  </Label>
</template>

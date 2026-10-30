<script setup lang="ts">
/**
 * Inline confirm in front of "delete model".
 *
 * Deleting a model is a chat prompt the agent runs at once, and on an
 * auto-merge project the model and all its content are gone on that one
 * click — from an unlabelled icon that sits where other panels keep "Edit
 * content". The first click arms it ("Delete model?"), only the second sends;
 * a click anywhere else or Escape disarms it. Same pattern as a branch's
 * Reject → "Discard N changes?".
 *
 * The idle trigger is the caller's (slot), so each place keeps its own look.
 */
const emit = defineEmits<{
  confirm: []
}>()

const { t } = useContent()
const armed = ref(false)
const root = ref<HTMLElement | null>(null)
const confirmButton = ref<HTMLButtonElement | null>(null)

function arm(e?: Event) {
  e?.stopPropagation()
  armed.value = true
  nextTick(() => confirmButton.value?.focus())
}

function confirm(e: Event) {
  e.stopPropagation()
  armed.value = false
  emit('confirm')
}

function onPointerDown(e: PointerEvent) {
  if (root.value && !root.value.contains(e.target as Node)) armed.value = false
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') armed.value = false
}

function listen(on: boolean) {
  if (on) {
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('keydown', onKeydown)
  }
  else {
    document.removeEventListener('pointerdown', onPointerDown, true)
    document.removeEventListener('keydown', onKeydown)
  }
}

watch(armed, listen)
onBeforeUnmount(() => listen(false))
</script>

<template>
  <span ref="root" class="inline-flex shrink-0 items-center">
    <button
      v-if="armed"
      ref="confirmButton"
      type="button"
      class="rounded border border-danger-600 bg-danger-600 px-2 py-0.5 text-xs font-medium text-white transition-colors hover:border-danger-700 hover:bg-danger-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-danger-500/50 dark:border-danger-500 dark:bg-danger-500 dark:hover:bg-danger-400"
      data-testid="delete-model-confirm"
      @click="confirm"
    >
      {{ t('content.delete_model_confirm') }}
    </button>
    <slot v-else :arm="arm" />
  </span>
</template>

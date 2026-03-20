<script setup lang="ts">
const { t } = useContent()

const props = defineProps<{
  disabled?: boolean
}>()

const emit = defineEmits<{
  send: [message: string]
}>()

const input = ref('')
const textareaRef = ref<HTMLTextAreaElement | null>(null)

function handleSend() {
  const text = input.value.trim()
  if (!text || props.disabled) return
  emit('send', text)
  input.value = ''
  nextTick(() => autoResize())
}

function handleKeydown(e: KeyboardEvent) {
  // Enter sends, Shift+Enter adds newline
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    handleSend()
  }
}

function autoResize() {
  const el = textareaRef.value
  if (!el) return
  el.style.height = 'auto'
  el.style.height = `${Math.min(el.scrollHeight, 160)}px`
}
</script>

<template>
  <div class="border-t border-secondary-200 p-3 dark:border-secondary-800">
    <div class="flex items-end gap-2">
      <textarea
        ref="textareaRef" v-model="input" :placeholder="t('chat.placeholder')" :disabled="disabled" rows="1"
        class="max-h-40 min-h-10 flex-1 resize-none rounded-xl border border-secondary-200 bg-white px-4 py-2.5 text-sm text-heading placeholder:text-muted focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-500/30 disabled:cursor-not-allowed disabled:opacity-50 dark:border-secondary-700 dark:bg-secondary-900 dark:text-secondary-100"
        @input="autoResize" @keydown="handleKeydown"
      />
      <AtomsBaseButton
        variant="primary" size="md" :disabled="!input.trim() || disabled" class="shrink-0 rounded-xl"
        @click="handleSend"
      >
        <template #prepend>
          <span class="icon-[annon--arrow-top] size-4" aria-hidden="true" />
        </template>
        <span class="sr-only">{{ t('chat.send') }}</span>
      </AtomsBaseButton>
    </div>
  </div>
</template>

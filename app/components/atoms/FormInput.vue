<script lang="ts" setup>
interface Props {
  modelValue?: string
  type?: 'text' | 'email' | 'password' | 'url' | 'search' | 'number' | 'date' | 'datetime-local' | 'color' | 'tel'
  placeholder?: string
  disabled?: boolean
  required?: boolean
  id?: string
  name?: string
  state?: 'default' | 'error' | 'success'
  description?: string
  /** Show a clear button inside the field once it has a value. */
  clearable?: boolean
}

const props = withDefaults(defineProps<Props>(), {
  modelValue: '',
  type: 'text',
  placeholder: '',
  disabled: false,
  required: false,
  state: 'default',
  clearable: false,
})

const emit = defineEmits<{
  'update:modelValue': [value: string]
}>()

const { t } = useContent()
const inputRef = ref<HTMLInputElement | null>(null)

const showClear = computed(() => props.clearable && !!props.modelValue && !props.disabled)

function onInput(event: Event) {
  const target = event.target as HTMLInputElement
  emit('update:modelValue', target.value)
}

// Deliberately no Escape handling: this atom sits inside dialogs that close on
// Escape (the command palette among them), and swallowing it there would trap
// the user in the modal.
function clear() {
  emit('update:modelValue', '')
  // The button disappears with the value, so focus would land on <body>.
  inputRef.value?.focus()
}
</script>

<template>
  <div class="flex flex-col gap-1">
    <div class="relative">
      <input
        :id="id"
        ref="inputRef"
        :type="type"
        :name="name"
        :value="modelValue"
        :placeholder="placeholder"
        :disabled="disabled"
        :required="required"
        :aria-invalid="state === 'error'"
        :aria-describedby="description && id ? `${id}-description` : undefined"
        class="w-full rounded-lg border px-3 py-2 text-sm bg-white dark:bg-secondary-900 text-secondary-900 dark:text-secondary-100 placeholder:text-muted transition-colors outline-none focus:ring-2 focus:ring-primary-500/30 disabled:cursor-not-allowed disabled:opacity-50 disabled:text-secondary-300 dark:disabled:text-secondary-600"
        :class="[
          {
            'border-secondary-200 dark:border-secondary-800 focus:border-primary-500': state === 'default',
            'border-danger-500 focus:border-danger-500 focus:ring-danger-500/30': state === 'error',
            'border-success-500 focus:border-success-500 focus:ring-success-500/30': state === 'success',
          },
          showClear ? 'pr-9' : '',
        ]"
        @input="onInput"
      >
      <button
        v-if="showClear"
        type="button"
        class="absolute inset-y-0 right-0 flex items-center rounded-lg px-2.5 text-muted transition-colors hover:text-body focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50 dark:hover:text-secondary-100"
        :aria-label="t('common.clear')"
        @click="clear"
      >
        <span class="icon-[annon--cross] block size-3.5" aria-hidden="true" />
      </button>
    </div>
    <p
      v-if="description"
      :id="id ? `${id}-description` : undefined"
      class="text-xs"
      :class="{
        'text-muted': state === 'default',
        'text-danger-500': state === 'error',
        'text-success-500': state === 'success',
      }"
    >
      {{ description }}
    </p>
  </div>
</template>

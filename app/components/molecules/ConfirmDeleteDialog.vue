<script setup lang="ts">
import {
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogOverlay,
  DialogPortal,
  DialogRoot,
  DialogTitle,
} from 'radix-vue'

const props = withDefaults(defineProps<{
  title: string
  description: string
  confirmText: string
  confirmLabel: string
  deleteLabel?: string
  deleting?: boolean
}>(), {
  deleteLabel: 'Delete',
  deleting: false,
})

const emit = defineEmits<{
  confirm: []
}>()

const { t } = useContent()
const open = defineModel<boolean>('open', { default: false })
const input = ref('')

const canDelete = computed(() => input.value === props.confirmText)

watch(open, (isOpen) => {
  if (!isOpen) input.value = ''
})
</script>

<template>
  <DialogRoot v-model:open="open">
    <DialogPortal>
      <DialogOverlay
        class="fixed inset-0 z-50 bg-black/50 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=closed]:animate-out data-[state=closed]:fade-out-0"
      />

      <DialogContent
        class="fixed left-1/2 top-1/2 z-50 w-full max-w-md -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-secondary-200 bg-white shadow-xl dark:border-secondary-800 dark:bg-secondary-950"
        @interact-outside.prevent
      >
        <!-- Header -->
        <div class="flex items-center justify-between border-b border-secondary-200 px-6 py-4 dark:border-secondary-800">
          <DialogTitle class="text-base font-semibold text-heading dark:text-secondary-100">
            {{ title }}
          </DialogTitle>
          <DialogClose
            class="rounded-lg p-1.5 text-muted transition-colors hover:bg-secondary-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50 dark:hover:bg-secondary-900"
          >
            <span class="icon-[annon--cross] block size-4" aria-hidden="true" />
          </DialogClose>
        </div>

        <!-- Body -->
        <div class="px-6 py-5">
          <DialogDescription class="sr-only">
            {{ description }}
          </DialogDescription>

          <!-- Warning -->
          <div class="flex items-start gap-3 rounded-lg border border-danger-200 bg-danger-50 p-3 dark:border-danger-500/20 dark:bg-danger-500/10">
            <span class="icon-[annon--alert-triangle] size-5 shrink-0 text-danger-500" aria-hidden="true" />
            <p class="text-sm text-danger-700 dark:text-danger-400">
              {{ description }}
            </p>
          </div>

          <!-- Confirm input -->
          <div class="mt-4">
            <AtomsFormLabel for-id="confirm-delete-input">
              {{ confirmLabel }}
              <code class="ml-1 rounded bg-secondary-100 px-1.5 py-0.5 text-xs font-semibold text-heading dark:bg-secondary-800 dark:text-secondary-100">{{ confirmText }}</code>
            </AtomsFormLabel>
            <AtomsFormInput
              id="confirm-delete-input"
              v-model="input"
              type="text"
              :placeholder="confirmText"
              class="mt-1.5"
              autocomplete="off"
            />
          </div>
        </div>

        <!-- Footer -->
        <div class="flex items-center justify-end gap-2 border-t border-secondary-200 px-6 py-4 dark:border-secondary-800">
          <DialogClose as-child>
            <AtomsBaseButton size="sm">
              {{ t('common.cancel') }}
            </AtomsBaseButton>
          </DialogClose>
          <AtomsBaseButton
            variant="danger"
            size="sm"
            :disabled="!canDelete || deleting"
            @click="emit('confirm')"
          >
            <template v-if="deleting" #prepend>
              <div class="size-3.5 animate-spin rounded-full border-2 border-white/30 border-t-white" />
            </template>
            {{ deleteLabel }}
          </AtomsBaseButton>
        </div>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>

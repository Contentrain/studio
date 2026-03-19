<script setup lang="ts">
import {
  ToastClose,
  ToastDescription,
  ToastProvider,
  ToastRoot,
  ToastTitle,
  ToastViewport,
} from 'radix-vue'

const { toasts, dismiss } = useToast()

const variantStyles: Record<string, { container: string, icon: string, iconClass: string }> = {
  success: {
    container: 'border-success-200 bg-success-50 dark:border-success-800 dark:bg-success-950',
    icon: 'icon-[annon--check-circle]',
    iconClass: 'text-success-500',
  },
  error: {
    container: 'border-danger-200 bg-danger-50 dark:border-danger-800 dark:bg-danger-950',
    icon: 'icon-[annon--alert-circle]',
    iconClass: 'text-danger-500',
  },
  info: {
    container: 'border-primary-200 bg-primary-50 dark:border-primary-800 dark:bg-primary-950',
    icon: 'icon-[annon--alert-circle]',
    iconClass: 'text-primary-500',
  },
  warning: {
    container: 'border-warning-200 bg-warning-50 dark:border-warning-800 dark:bg-warning-950',
    icon: 'icon-[annon--alert-triangle]',
    iconClass: 'text-warning-500',
  },
}
</script>

<template>
  <ToastProvider :duration="4000" swipe-direction="right">
    <ToastRoot
      v-for="toast in toasts" :key="toast.id"
      class="group pointer-events-auto flex w-full items-start gap-3 rounded-xl border p-4 shadow-lg transition-all data-[state=open]:animate-in data-[state=open]:slide-in-from-right-full data-[state=closed]:animate-out data-[state=closed]:slide-out-to-right-full data-[swipe=end]:animate-out data-[swipe=end]:slide-out-to-right-full"
      :class="variantStyles[toast.variant].container" @update:open="(open) => { if (!open) dismiss(toast.id) }"
    >
      <span
        :class="[variantStyles[toast.variant].icon, variantStyles[toast.variant].iconClass]"
        class="mt-0.5 size-5 shrink-0" aria-hidden="true"
      />
      <div class="min-w-0 flex-1">
        <ToastTitle class="text-sm font-medium text-heading dark:text-secondary-100">
          {{ toast.title }}
        </ToastTitle>
        <ToastDescription v-if="toast.description" class="mt-0.5 text-sm text-muted">
          {{ toast.description }}
        </ToastDescription>
      </div>
      <ToastClose
        class="shrink-0 rounded p-0.5 text-muted opacity-0 transition-opacity hover:text-heading group-hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50 dark:hover:text-secondary-100"
      >
        <span class="icon-[annon--cross] block size-4" aria-hidden="true" />
      </ToastClose>
    </ToastRoot>

    <ToastViewport class="fixed bottom-0 right-0 z-100 flex max-w-md flex-col gap-2 p-6 outline-none" />
  </ToastProvider>
</template>

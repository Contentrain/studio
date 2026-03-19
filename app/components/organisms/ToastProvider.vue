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

interface VariantStyle {
  accent: string
  icon: string
  iconClass: string
}

const variantStyles: Record<string, VariantStyle> = {
  success: {
    accent: 'before:bg-success-500',
    icon: 'icon-[annon--check-circle]',
    iconClass: 'text-success-500',
  },
  error: {
    accent: 'before:bg-danger-500',
    icon: 'icon-[annon--alert-circle]',
    iconClass: 'text-danger-500',
  },
  info: {
    accent: 'before:bg-primary-500',
    icon: 'icon-[annon--alert-circle]',
    iconClass: 'text-primary-500',
  },
  warning: {
    accent: 'before:bg-warning-500',
    icon: 'icon-[annon--alert-triangle]',
    iconClass: 'text-warning-500',
  },
}

const fallback = variantStyles.info

function getStyle(variant: string): VariantStyle {
  return variantStyles[variant] as VariantStyle ?? fallback
}
</script>

<template>
  <ToastProvider :duration="4000" swipe-direction="right">
    <ToastRoot
      v-for="toast in toasts"
      :key="toast.id"
      class="group pointer-events-auto relative flex w-full items-start gap-3 overflow-hidden rounded-lg border border-secondary-200 bg-white p-4 shadow-lg before:absolute before:inset-y-0 before:left-0 before:w-1 dark:border-secondary-800 dark:bg-secondary-900"
      :class="getStyle(toast.variant).accent"
      @update:open="(open: boolean) => { if (!open) dismiss(toast.id) }"
    >
      <span
        :class="[getStyle(toast.variant).icon, getStyle(toast.variant).iconClass]"
        class="mt-0.5 size-5 shrink-0"
        aria-hidden="true"
      />
      <div class="min-w-0 flex-1">
        <ToastTitle class="text-sm font-medium text-secondary-900 dark:text-secondary-100">
          {{ toast.title }}
        </ToastTitle>
        <ToastDescription v-if="toast.description" class="mt-0.5 text-sm text-muted">
          {{ toast.description }}
        </ToastDescription>
      </div>
      <ToastClose
        class="shrink-0 rounded p-0.5 text-muted opacity-0 transition-opacity hover:text-secondary-900 group-hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50 dark:hover:text-secondary-100"
      >
        <span class="icon-[annon--cross] block size-4" aria-hidden="true" />
      </ToastClose>
    </ToastRoot>

    <ToastViewport class="fixed bottom-0 right-0 z-100 flex max-w-sm flex-col gap-2 p-6 outline-none" />
  </ToastProvider>
</template>

export interface ToastItem {
  id: string
  variant: 'success' | 'error' | 'info' | 'warning'
  title: string
  description?: string
  /** A next step that lives elsewhere (a pull request on GitHub); keeps the toast up longer. */
  link?: { href: string, label: string }
}

const toasts = ref<ToastItem[]>([])

let counter = 0

function addToast(variant: ToastItem['variant'], title: string, description?: string, link?: ToastItem['link']) {
  const id = `toast-${++counter}`
  toasts.value.push({ id, variant, title, description, link })
}

function removeToast(id: string) {
  toasts.value = toasts.value.filter(t => t.id !== id)
}

export function useToast() {
  return {
    toasts: readonly(toasts),
    success: (title: string, description?: string) => addToast('success', title, description),
    error: (title: string, description?: string) => addToast('error', title, description),
    info: (title: string, description?: string) => addToast('info', title, description),
    warning: (title: string, description?: string, link?: ToastItem['link']) => addToast('warning', title, description, link),
    dismiss: removeToast,
  }
}

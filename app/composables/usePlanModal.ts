/**
 * Global plan-selection modal state.
 *
 * Mounted once per layout (`default`, `workspace`) and triggered from
 * anywhere via `usePlanModal().show()`. The primary trigger is the
 * client-side 402 + `requiresCheckout` handler in `resolveApiError`,
 * so any API call that hits a billing-locked state surfaces the
 * checkout flow instead of dying as a toast.
 */
export function usePlanModal() {
  const open = useState<boolean>('plan-modal-open', () => false)

  function show() {
    open.value = true
  }

  function hide() {
    open.value = false
  }

  return { open, show, hide }
}

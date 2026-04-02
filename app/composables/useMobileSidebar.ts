export function useMobileSidebar() {
  const isOpen = useState('mobile-sidebar', () => false)

  function open() {
    isOpen.value = true
  }
  function close() {
    isOpen.value = false
  }
  function toggle() {
    isOpen.value = !isOpen.value
  }

  return { isOpen, open, close, toggle }
}

/**
 * Global command palette state.
 * Shared between layout (renders palette) and sidebar (opens it).
 */
export function useCommandPalette() {
  const open = useState('command-palette-open', () => false)

  function toggle() {
    open.value = !open.value
  }

  return {
    open,
    toggle,
  }
}

type Theme = 'light' | 'dark' | 'system'

export function useTheme() {
  const theme = useState<Theme>('theme', () => 'system')

  const isDark = computed(() => {
    if (import.meta.server) return false
    if (theme.value === 'dark') return true
    if (theme.value === 'light') return false
    return window.matchMedia('(prefers-color-scheme: dark)').matches
  })

  function setTheme(value: Theme) {
    theme.value = value
    applyTheme()

    if (import.meta.client)
      localStorage.setItem('contentrain-theme', value)
  }

  function toggle() {
    setTheme(isDark.value ? 'light' : 'dark')
  }

  function applyTheme() {
    if (import.meta.server) return

    const root = document.documentElement
    if (theme.value === 'dark' || (theme.value === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)) {
      root.classList.add('dark')
    }
    else {
      root.classList.remove('dark')
    }
  }

  function init() {
    if (import.meta.server) return

    const stored = localStorage.getItem('contentrain-theme') as Theme | null
    if (stored) theme.value = stored

    applyTheme()

    // Listen for system preference changes
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
      if (theme.value === 'system') applyTheme()
    })
  }

  return {
    theme: readonly(theme),
    isDark,
    setTheme,
    toggle,
    init,
  }
}

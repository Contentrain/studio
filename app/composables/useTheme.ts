type Theme = 'light' | 'dark' | 'system'

export function useTheme() {
  const theme = useState<Theme>('theme', () => 'system')

  const isDark = computed(() => {
    if (theme.value === 'dark') return true
    if (theme.value === 'light') return false
    return window.matchMedia('(prefers-color-scheme: dark)').matches
  })

  function setTheme(value: Theme) {
    theme.value = value
    applyTheme()
    localStorage.setItem('contentrain-theme', value)

    // Persist to server (fire-and-forget for authenticated users)
    $fetch('/api/profile', {
      method: 'PATCH',
      body: { theme: value },
    }).catch(() => {
      // Silently fail — localStorage is the immediate source of truth
    })
  }

  function toggle() {
    setTheme(isDark.value ? 'light' : 'dark')
  }

  function applyTheme() {
    const root = document.documentElement
    if (theme.value === 'dark' || (theme.value === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)) {
      root.classList.add('dark')
    }
    else {
      root.classList.remove('dark')
    }
  }

  // Track listener for cleanup
  const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)')
  const onSystemChange = () => {
    if (theme.value === 'system') applyTheme()
  }

  function init() {
    // Priority: server (auth state) > localStorage > default 'system'
    const { state: authState } = useAuth()
    const serverTheme = authState.value.user?.theme
    if (serverTheme && serverTheme !== 'system') {
      theme.value = serverTheme
      localStorage.setItem('contentrain-theme', serverTheme)
    }
    else {
      const stored = localStorage.getItem('contentrain-theme') as Theme | null
      if (stored) theme.value = stored
    }

    applyTheme()

    // Listen for system preference changes
    mediaQuery.addEventListener('change', onSystemChange)
  }

  function cleanup() {
    mediaQuery.removeEventListener('change', onSystemChange)
  }

  return {
    theme: readonly(theme),
    isDark,
    setTheme,
    toggle,
    init,
    cleanup,
  }
}

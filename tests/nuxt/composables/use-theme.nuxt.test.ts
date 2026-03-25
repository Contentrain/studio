import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useTheme } from '../../../app/composables/useTheme'

describe('useTheme', () => {
  beforeEach(() => {
    localStorage.clear()
    document.documentElement.className = ''
    useState('theme').value = 'system'
  })

  it('initializes from local storage and applies dark mode', () => {
    const addEventListener = vi.fn()
    const removeEventListener = vi.fn()
    vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({
      matches: true,
      addEventListener,
      removeEventListener,
    }))
    localStorage.setItem('contentrain-theme', 'dark')

    const theme = useTheme()
    theme.init()

    expect(theme.theme.value).toBe('dark')
    expect(theme.isDark.value).toBe(true)
    expect(document.documentElement.classList.contains('dark')).toBe(true)
    expect(addEventListener).toHaveBeenCalledWith('change', expect.any(Function))

    theme.cleanup()
    expect(removeEventListener).toHaveBeenCalledWith('change', expect.any(Function))
  })

  it('toggles between light and dark and persists the selection', () => {
    vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }))

    const theme = useTheme()
    theme.setTheme('light')
    theme.toggle()

    expect(theme.theme.value).toBe('dark')
    expect(localStorage.getItem('contentrain-theme')).toBe('dark')
    expect(document.documentElement.classList.contains('dark')).toBe(true)
  })
})

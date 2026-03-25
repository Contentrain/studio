import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mockNuxtImport } from '@nuxt/test-utils/runtime'
import { useAuth } from '../../../app/composables/useAuth'

const push = vi.fn()
const replace = vi.fn()
const beforeEachHook = vi.fn()
const afterEachHook = vi.fn()
const beforeResolveHook = vi.fn()
const resolve = vi.fn((to?: string | { path?: string }) => ({
  href: typeof to === 'string' ? to : to?.path ?? '/',
}))

mockNuxtImport('useRouter', () => () => ({
  push,
  replace,
  beforeEach: beforeEachHook,
  afterEach: afterEachHook,
  beforeResolve: beforeResolveHook,
  resolve,
}))

describe('useAuth', () => {
  beforeEach(() => {
    push.mockReset()
    replace.mockReset()
    beforeEachHook.mockReset()
    afterEachHook.mockReset()
    beforeResolveHook.mockReset()
    resolve.mockClear()
    useState('auth').value = {
      user: null,
      loading: true,
    }
    sessionStorage.clear()
    window.location.href = 'http://localhost:3000/auth/login'
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('loads the authenticated user during init', async () => {
    vi.stubGlobal('$fetch', vi.fn().mockResolvedValue({
      user: {
        id: 'user-1',
        email: 'user@example.com',
        avatarUrl: null,
        provider: 'github',
      },
    }))

    const auth = useAuth()
    await auth.init()

    expect(auth.isAuthenticated.value).toBe(true)
    expect(auth.state.value.user?.email).toBe('user@example.com')
    expect(auth.state.value.loading).toBe(false)
  })

  it('stores oauth state and redirects to the provider url', async () => {
    vi.stubGlobal('$fetch', vi.fn().mockResolvedValue({
      url: 'https://example.com/oauth/github',
      state: 'oauth-state-token',
    }))

    const auth = useAuth()
    await auth.signInWithOAuth('github')

    expect(sessionStorage.getItem('contentrain-auth-state')).toBe('oauth-state-token')
    expect(window.location.href).toBe('https://example.com/oauth/github')
  })

  it('clears user state and redirects to login on signOut', async () => {
    vi.stubGlobal('$fetch', vi.fn()
      .mockResolvedValueOnce({
        user: {
          id: 'user-1',
          email: 'user@example.com',
          avatarUrl: null,
          provider: 'github',
        },
      })
      .mockResolvedValueOnce({}))

    const auth = useAuth()
    await auth.init()

    await auth.signOut()

    expect(auth.state.value.user).toBeNull()
    expect(push).toHaveBeenCalledWith('/auth/login')
  })
})

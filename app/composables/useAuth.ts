interface AuthUser {
  id: string
  email: string | null
  avatarUrl: string | null
  provider: string | null
}

interface AuthState {
  user: AuthUser | null
  loading: boolean
}

export function useAuth() {
  const router = useRouter()

  const state = useState<AuthState>('auth', () => ({
    user: null,
    loading: true,
  }))

  const isAuthenticated = computed(() => !!state.value.user)

  async function init() {
    state.value.loading = true
    try {
      const { user } = await $fetch<{ user: AuthUser }>('/api/auth/me')
      state.value.user = user
    }
    catch {
      state.value.user = null
    }
    finally {
      state.value.loading = false
    }
  }

  async function signInWithOAuth(provider: 'github' | 'google') {
    const { url } = await $fetch<{ url: string }>('/api/auth/login', {
      method: 'POST',
      body: { provider, redirectTo: '/auth/callback' },
    })
    window.location.href = url
  }

  async function signInWithMagicLink(email: string) {
    await $fetch('/api/auth/magic-link', {
      method: 'POST',
      body: { email },
    })
  }

  async function signOut() {
    await $fetch('/api/auth/logout', { method: 'POST' })
    state.value.user = null
    await router.push('/auth/login')
  }

  return {
    state: readonly(state),
    isAuthenticated,
    init,
    signInWithOAuth,
    signInWithMagicLink,
    signOut,
  }
}

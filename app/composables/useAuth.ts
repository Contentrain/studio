import type { Session, User } from '@supabase/supabase-js'

interface AuthState {
  user: User | null
  session: Session | null
  loading: boolean
}

export function useAuth() {
  const { $supabase } = useNuxtApp()
  const router = useRouter()

  const state = useState<AuthState>('auth', () => ({
    user: null,
    session: null,
    loading: true,
  }))

  const isAuthenticated = computed(() => !!state.value.session)

  async function init() {
    state.value.loading = true

    const { data: { session } } = await $supabase.auth.getSession()

    if (session) {
      state.value.session = session
      state.value.user = session.user
    }

    state.value.loading = false

    // Listen for auth state changes (login, logout, token refresh)
    $supabase.auth.onAuthStateChange((_event, session) => {
      state.value.session = session
      state.value.user = session?.user ?? null
    })
  }

  async function signInWithOAuth(provider: 'github' | 'google') {
    const { error } = await $supabase.auth.signInWithOAuth({
      provider,
      options: {
        redirectTo: `${window.location.origin}/auth/callback`,
        scopes: provider === 'github' ? 'read:user user:email' : undefined,
      },
    })

    if (error)
      throw error
  }

  async function signInWithMagicLink(email: string) {
    const { error } = await $supabase.auth.signInWithOtp({
      email,
      options: {
        emailRedirectTo: `${window.location.origin}/auth/callback`,
      },
    })

    if (error)
      throw error
  }

  async function signOut() {
    const { error } = await $supabase.auth.signOut()
    if (error)
      throw error

    state.value.user = null
    state.value.session = null
    await router.push('/auth/login')
  }

  /**
   * Get the current access token for API calls
   */
  function getAccessToken(): string | null {
    return state.value.session?.access_token ?? null
  }

  return {
    state: readonly(state),
    isAuthenticated,
    init,
    signInWithOAuth,
    signInWithMagicLink,
    signOut,
    getAccessToken,
  }
}

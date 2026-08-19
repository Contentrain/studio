const PUBLIC_ROUTES = ['/auth/login', '/auth/callback']

export default defineNuxtRouteMiddleware(async (to) => {
  // Routes that carry `definePageMeta({ auth: false })` are rendered
  // for every visitor regardless of authentication — neither
  // redirected to login nor bounced back to the dashboard. Used by
  // the public `/about` page (AGPL §13 source offer).
  if (to.meta.auth === false) return

  const { isAuthenticated, state } = useAuth()

  const isPublic = PUBLIC_ROUTES.some(route => to.path.startsWith(route))

  // Preserve the intended destination across the login bounce (e.g. the
  // OAuth consent screen) — login/callback thread it back after sign-in.
  const loginTarget = to.fullPath === '/'
    ? '/auth/login'
    : `/auth/login?redirect=${encodeURIComponent(to.fullPath)}`

  // Wait for auth to initialize before making decisions
  if (state.value.loading) {
    // During auth init, block protected routes — redirect to login to avoid flash of protected content
    if (!isPublic) {
      return navigateTo(loginTarget)
    }
    return
  }

  // Redirect authenticated users away from auth pages — honoring a pending
  // redirect target. Server-route targets (/oauth/authorize) need a real
  // navigation; Vue Router has no matching route for them.
  if (isPublic && isAuthenticated.value) {
    const redirect = safeInternalRedirect(to.query.redirect)
    if (redirect) {
      return redirect.startsWith('/oauth/')
        ? navigateTo(redirect, { external: true })
        : navigateTo(redirect)
    }
    return navigateTo('/')
  }

  // Redirect unauthenticated users to login
  if (!isPublic && !isAuthenticated.value)
    return navigateTo(loginTarget)
})

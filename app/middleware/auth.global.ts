const PUBLIC_ROUTES = ['/auth/login', '/auth/callback']

export default defineNuxtRouteMiddleware(async (to) => {
  // Routes that carry `definePageMeta({ auth: false })` are rendered
  // for every visitor regardless of authentication — neither
  // redirected to login nor bounced back to the dashboard. Used by
  // the public `/about` page (AGPL §13 source offer).
  if (to.meta.auth === false) return

  const { isAuthenticated, state } = useAuth()

  // Wait for auth to initialize before making decisions
  if (state.value.loading) {
    // During auth init, block protected routes — redirect to login to avoid flash of protected content
    const isPublic = PUBLIC_ROUTES.some(route => to.path.startsWith(route))
    if (!isPublic) {
      return navigateTo('/auth/login')
    }
    return
  }

  const isPublic = PUBLIC_ROUTES.some(route => to.path.startsWith(route))

  // Redirect authenticated users away from auth pages to dashboard
  if (isPublic && isAuthenticated.value)
    return navigateTo('/')

  // Redirect unauthenticated users to login
  if (!isPublic && !isAuthenticated.value)
    return navigateTo('/auth/login')
})

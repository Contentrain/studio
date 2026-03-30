const PUBLIC_ROUTES = ['/auth/login', '/auth/callback']

export default defineNuxtRouteMiddleware(async (to) => {
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

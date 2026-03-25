const PUBLIC_ROUTES = ['/auth/login', '/auth/callback']

export default defineNuxtRouteMiddleware(async (to) => {
  const { isAuthenticated, state } = useAuth()

  // Wait for auth to initialize before making decisions
  if (state.value.loading) {
    // Auth still loading — let the page render (auth plugin will resolve)
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

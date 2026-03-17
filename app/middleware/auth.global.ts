const PUBLIC_ROUTES = ['/auth/login', '/auth/callback']

export default defineNuxtRouteMiddleware((to) => {
  // Only run on client
  if (import.meta.server)
    return

  const { isAuthenticated, state } = useAuth()

  // Wait for auth to initialize
  if (state.value.loading)
    return

  const isPublic = PUBLIC_ROUTES.some(route => to.path.startsWith(route))

  // Redirect authenticated users away from auth pages
  if (isPublic && isAuthenticated.value)
    return navigateTo('/')

  // Redirect unauthenticated users to login
  if (!isPublic && !isAuthenticated.value)
    return navigateTo('/auth/login')
})

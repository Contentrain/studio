export default defineEventHandler((event) => {
  const session = requireAuth(event)
  return { user: session.user }
})

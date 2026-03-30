export default defineEventHandler(async (event) => {
  const session = requireAuth(event)
  return useDatabaseProvider().listUserWorkspaces(session.accessToken, session.user.id)
})

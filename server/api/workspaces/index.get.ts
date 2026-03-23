export default defineEventHandler(async (event) => {
  const session = requireAuth(event)
  return listUserWorkspaces(useSupabaseUserClient(session.accessToken))
})

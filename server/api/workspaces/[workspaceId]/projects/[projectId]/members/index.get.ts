/**
 * List project members with their profiles.
 */
export default defineEventHandler(async (event) => {
  const session = requireAuth(event)
  const projectId = getRouterParam(event, 'projectId')

  if (!projectId)
    throw createError({ statusCode: 400, message: 'projectId is required' })

  return listProjectMembers(useSupabaseUserClient(session.accessToken), projectId)
})

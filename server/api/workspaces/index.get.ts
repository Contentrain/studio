export default defineEventHandler(async (event) => {
  const session = requireAuth(event)
  const client = useSupabaseUserClient(session.accessToken)

  const { data, error } = await client
    .from('workspaces')
    .select(`
      *,
      workspace_members!inner(role)
    `)
    .order('created_at', { ascending: true })

  if (error)
    throw createError({ statusCode: 500, message: error.message })

  return data
})

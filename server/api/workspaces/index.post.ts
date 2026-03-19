export default defineEventHandler(async (event) => {
  const session = requireAuth(event)
  const body = await readBody<{
    name: string
    slug: string
  }>(event)

  if (!body.name || !body.slug)
    throw createError({ statusCode: 400, message: 'name and slug are required' })

  const client = useSupabaseUserClient(session.accessToken)

  const { data, error } = await client
    .from('workspaces')
    .insert({
      name: body.name,
      slug: slugify(body.slug),
      type: 'secondary',
      owner_id: session.user.id,
    })
    .select()
    .single()

  if (error)
    throw createError({ statusCode: 500, message: error.message })

  // Owner is auto-added as workspace member via DB trigger
  return data
})

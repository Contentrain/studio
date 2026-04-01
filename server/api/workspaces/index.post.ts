export default defineEventHandler(async (event) => {
  const session = requireAuth(event)
  const db = useDatabaseProvider()
  const body = await readBody<{
    name: string
    slug: string
  }>(event)

  if (!body.name || !body.slug)
    throw createError({ statusCode: 400, message: errorMessage('validation.name_slug_required') })

  // Owner is auto-added as workspace member via DB trigger
  // New workspaces start with a 14-day trial
  const workspace = await db.createWorkspace(session.accessToken, {
    ownerId: session.user.id,
    name: body.name,
    slug: slugify(body.slug),
    type: 'secondary',
  })

  // Set trial period
  const trialEndsAt = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString()
  await db.updateWorkspace(session.accessToken, (workspace as { id: string }).id, { trial_ends_at: trialEndsAt })

  return workspace
})

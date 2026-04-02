export default defineEventHandler(async (event) => {
  const session = requireAuth(event)
  const db = useDatabaseProvider()
  const body = await readBody<{
    name: string
    slug: string
  }>(event)

  if (!body.name || !body.slug)
    throw createError({ statusCode: 400, message: errorMessage('validation.name_slug_required') })

  // Owner is auto-added as workspace member via DB trigger.
  // New workspaces start on free plan — trial begins when user subscribes
  // via Stripe Checkout (trial_period_days=14 on the subscription).
  const workspace = await db.createWorkspace(session.accessToken, {
    ownerId: session.user.id,
    name: body.name,
    slug: slugify(body.slug),
    type: 'secondary',
  })

  return workspace
})

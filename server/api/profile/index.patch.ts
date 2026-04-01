export default defineEventHandler(async (event) => {
  const session = requireAuth(event)
  const db = useDatabaseProvider()
  const body = await readBody<{ displayName?: string, theme?: string }>(event)

  const updates: Record<string, unknown> = {}

  if (body.displayName !== undefined) {
    const name = body.displayName.trim()
    if (name.length < 1 || name.length > 100) {
      throw createError({ statusCode: 400, message: errorMessage('profile.name_invalid') })
    }
    updates.display_name = name
  }

  if (body.theme !== undefined) {
    if (!['light', 'dark', 'system'].includes(body.theme)) {
      throw createError({ statusCode: 400, message: errorMessage('profile.invalid_theme') })
    }
    updates.theme = body.theme
  }

  if (Object.keys(updates).length === 0) {
    throw createError({ statusCode: 400, message: 'No fields to update' })
  }

  return db.updateProfile(session.accessToken, session.user.id, updates as { display_name?: string, theme?: 'light' | 'dark' | 'system' })
})

/**
 * Remove custom avatar, reverting to OAuth provider avatar.
 */
export default defineEventHandler(async (event) => {
  const session = requireAuth(event)
  const db = useDatabaseProvider()

  await db.updateProfile(session.accessToken, session.user.id, { avatar_url: null })

  return { avatarUrl: null }
})

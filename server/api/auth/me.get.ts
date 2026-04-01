export default defineEventHandler(async (event) => {
  const session = requireAuth(event)
  const db = useDatabaseProvider()
  const profile = await db.getProfile(session.accessToken, session.user.id)

  return {
    user: {
      ...session.user,
      displayName: (profile?.display_name as string) ?? null,
    },
  }
})

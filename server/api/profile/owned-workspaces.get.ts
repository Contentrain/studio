/**
 * List owned secondary workspaces with their members.
 * Used by account deletion flow to show transfer requirements.
 */
export default defineEventHandler(async (event) => {
  const session = requireAuth(event)
  const db = useDatabaseProvider()

  const workspaces = await db.listOwnedSecondaryWorkspacesWithMembers(session.accessToken, session.user.id)

  // Filter to only workspaces that have other members (not just the owner)
  return (workspaces ?? []).filter((ws) => {
    const members = ws.workspace_members as Array<{ user_id: string }> | undefined
    return members && members.some(m => m.user_id !== session.user.id)
  })
})

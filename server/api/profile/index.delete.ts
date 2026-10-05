/**
 * Delete the authenticated user's account permanently.
 *
 * Cleans R2 storage for all owned workspaces' projects before
 * deleting from auth.users — CASCADE handles profiles, workspaces,
 * members, projects, and all child records.
 */
import { listBillingWorkspaces, listBlockingWorkspaces } from '../../utils/account-delete-guard'

export default defineEventHandler(async (event) => {
  const session = requireAuth(event)
  const db = useDatabaseProvider()
  const authProvider = useAuthProvider()

  // Same rule the account screen shows: workspaces with other members need a new owner first.
  const blocking = await listBlockingWorkspaces(db, session.accessToken, session.user.id)
  if (blocking.length > 0) {
    throw createError({
      statusCode: 409,
      message: errorMessage('account.transfer_required'),
      data: { code: 'ownership_transfer_required', workspaces: blocking.map(w => w.id as string) },
    })
  }

  const workspaces = await db.listUserWorkspaces(session.accessToken, session.user.id)
  const ownedWorkspaces = (workspaces ?? []).filter(w => w.owner_id === session.user.id)

  // A subscription still billing would be left behind once the workspace is deleted: cancel it first.
  const billing = await listBillingWorkspaces(db, ownedWorkspaces.map(w => w.id as string))
  if (billing.length > 0) {
    throw createError({
      statusCode: 409,
      message: errorMessage('account.subscription_active'),
      data: { code: 'active_subscription', workspaces: billing },
    })
  }

  // Clean R2 storage for all owned workspaces' projects

  const cdn = useCDNProvider()
  if (cdn) {
    for (const ws of ownedWorkspaces) {
      const projects = await db.listWorkspaceProjectsAdmin(ws.id as string)
      for (const project of projects ?? []) {
        try {
          await cdn.deletePrefix(project.id as string, '')
        }
        catch (e) {
          // R2 cleanup failure should not block account deletion, but surface it.
          reportDataLossRisk(e, { op: 'account-delete.r2', projectId: project.id as string, workspaceId: ws.id as string })
        }
      }
    }
  }

  // Delete from auth.users — CASCADE handles the entire chain
  await authProvider.deleteUser(session.user.id)

  // Clear the session cookie
  await clearServerSession(event)

  return { deleted: true }
})

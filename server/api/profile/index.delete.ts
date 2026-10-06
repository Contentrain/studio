/**
 * Delete the authenticated user's account permanently.
 *
 * Deletes from auth.users — CASCADE handles profiles, workspaces,
 * members, projects, and all child records — and only then cleans R2
 * storage for the owned workspaces' projects (a refused delete must not
 * wipe files of an account that stays).
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

  // The projects are gone from the database once the cascade has run, so list them first.
  const cdn = useCDNProvider()
  const ownedProjects: Array<{ projectId: string, workspaceId: string }> = []
  if (cdn) {
    for (const ws of ownedWorkspaces) {
      const projects = await db.listWorkspaceProjectsAdmin(ws.id as string)
      for (const project of projects ?? [])
        ownedProjects.push({ projectId: project.id as string, workspaceId: ws.id as string })
    }
  }

  // Delete from auth.users — CASCADE handles the entire chain. A row that still pins the profile
  // (a FK without a delete action) must come back as a clear, logged refusal, never a bare 500,
  // and must leave the account AND its CDN files untouched.
  try {
    await authProvider.deleteUser(session.user.id)
  }
  catch (e) {
    reportDataLossRisk(e, { op: 'account-delete.auth-user', userId: session.user.id })
    throw createError({
      statusCode: 409,
      message: errorMessage('account.delete_blocked'),
      data: { code: 'account_delete_blocked' },
    })
  }

  // Storage cleanup only after the account is really gone. Best-effort: a failure leaves orphaned
  // files, never a half-deleted account, and is surfaced.
  if (cdn) {
    for (const { projectId, workspaceId } of ownedProjects) {
      try {
        await cdn.deletePrefix(projectId, '')
      }
      catch (e) {
        reportDataLossRisk(e, { op: 'account-delete.r2', projectId, workspaceId })
      }
    }
  }

  // Clear the session cookie
  await clearServerSession(event)

  return { deleted: true }
})

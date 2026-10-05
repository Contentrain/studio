/**
 * What stops an account from being deleted. One source for the UI's
 * `/api/profile/owned-workspaces` list and for `DELETE /api/profile`, so the
 * server refuses exactly what the screen already shows as blocking.
 */
import type { DatabaseProvider } from '../providers/database'

/** Owned secondary workspaces that still have other members: ownership must move first. */
export async function listBlockingWorkspaces(db: DatabaseProvider, accessToken: string, userId: string) {
  const workspaces = await db.listOwnedSecondaryWorkspacesWithMembers(accessToken, userId)
  return (workspaces ?? []).filter((ws) => {
    const members = ws.workspace_members as Array<{ user_id: string }> | undefined
    return members && members.some(m => m.user_id !== userId)
  })
}

/** Subscription states that would keep billing once the workspace row is gone. */
const BILLING_STATUSES = ['active', 'trialing', 'past_due']

/** Owned workspaces (primary too: deleting the user deletes them) with a subscription that is still billing or about to. */
export async function listBillingWorkspaces(db: DatabaseProvider, ownedWorkspaceIds: string[]): Promise<string[]> {
  const billing: string[] = []
  for (const id of ownedWorkspaceIds) {
    const account = await db.getActivePaymentAccount(id)
    const status = account?.subscription_status as string | null | undefined
    if (account?.subscription_id && status && BILLING_STATUSES.includes(status)) billing.push(id)
  }
  return billing
}

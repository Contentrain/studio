/**
 * Owned workspaces whose plan is already set to end with its period. The account
 * screen warns about them before deleting: access ends at once, not at the period's end.
 */
import { listEndingPlans } from '../../utils/account-delete-guard'

export default defineEventHandler(async (event) => {
  const session = requireAuth(event)
  const db = useDatabaseProvider()

  const workspaces = await db.listUserWorkspaces(session.accessToken, session.user.id)
  const owned = (workspaces ?? []).filter(w => w.owner_id === session.user.id).map(w => w.id as string)
  return listEndingPlans(db, owned)
})

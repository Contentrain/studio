/**
 * List owned secondary workspaces with their members.
 * Used by account deletion flow to show transfer requirements.
 */
import { listBlockingWorkspaces } from '../../utils/account-delete-guard'

export default defineEventHandler(async (event) => {
  const session = requireAuth(event)
  const db = useDatabaseProvider()

  return listBlockingWorkspaces(db, session.accessToken, session.user.id)
})

/**
 * Audit middleware — pre-deletion snapshot.
 *
 * Runs after auth middleware (01.auth.ts). On DELETE requests,
 * matches the route against the auditable route registry, snapshots
 * the record before the handler deletes it, and stores the snapshot
 * in event.context._audit for the audit-writer plugin to persist
 * after a successful response.
 *
 * Zero changes required in DELETE endpoint handlers.
 */
import { buildAuditSnapshot, matchAuditableRoute } from '../utils/audit'

export default defineEventHandler(async (event) => {
  if (event.method !== 'DELETE') return

  // Auth middleware must have run — no auth means handler will 401 anyway
  const auth = event.context.auth as { user: { id: string } } | undefined
  if (!auth) return

  const path = getRequestPath(event)
  const match = matchAuditableRoute(path)
  if (!match) return

  const { route, matches } = match

  try {
    const db = useDatabaseProvider()
    const snapshot = await route.snapshot(db, route.extractIds(matches))
    event.context._audit = buildAuditSnapshot(event, route, matches, snapshot, auth.user.id)
  }
  catch {
    // Snapshot failure must never block the user's DELETE request.
    // The DB trigger on form_submissions is the safety net.
    // eslint-disable-next-line no-console
    console.warn('[audit] Pre-deletion snapshot failed for', path)
  }
})

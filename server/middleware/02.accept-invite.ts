/**
 * Auto-accept pending invitations.
 *
 * When an authenticated user accesses a workspace-scoped route,
 * this middleware updates accepted_at on their workspace_members
 * and project_members rows if still null.
 *
 * Runs after 01.auth.ts — requires event.context.auth to be set.
 * Best-effort: errors are logged, never thrown.
 */

const WORKSPACE_PATH_RE = /^\/api\/workspaces\/([^/]+)/

// In-memory cache to avoid repeated DB lookups per user+workspace
const acceptedCache = new Set<string>()

export default defineEventHandler(async (event) => {
  const path = getRequestPath(event)

  // Only workspace-scoped API routes
  const match = path.match(WORKSPACE_PATH_RE)
  if (!match) return

  const auth = event.context.auth as { user: { id: string } } | undefined
  if (!auth?.user?.id) return

  const workspaceId = match[1]
  const cacheKey = `${auth.user.id}:${workspaceId}`

  // Skip if already accepted in this server lifetime
  if (acceptedCache.has(cacheKey)) return

  try {
    const admin = useSupabaseAdmin()

    // Update workspace_members accepted_at
    const { data } = await admin
      .from('workspace_members')
      .update({ accepted_at: new Date().toISOString() })
      .eq('user_id', auth.user.id)
      .eq('workspace_id', workspaceId)
      .is('accepted_at', null)
      .select('id')

    if (data?.length) {
      // Also accept project memberships in this workspace
      const { data: projects } = await admin
        .from('projects')
        .select('id')
        .eq('workspace_id', workspaceId)

      if (projects?.length) {
        const projectIds = projects.map(p => p.id)
        await admin
          .from('project_members')
          .update({ accepted_at: new Date().toISOString() })
          .eq('user_id', auth.user.id)
          .in('project_id', projectIds)
          .is('accepted_at', null)
      }
    }

    // Cache regardless of whether update happened — avoid future queries
    acceptedCache.add(cacheKey)
  }
  catch {
    // Best-effort — don't block the request
  }
})

/**
 * GET /api/oauth/consent — data for the consent screen.
 *
 * Session-guarded by the auth middleware (`/api/oauth/` is deliberately NOT
 * in its public-path allowlist). Unseals the pending authorization flow
 * cookie and returns the client identity plus the user's workspace→project
 * tree with per-entry eligibility, so the page can render the picker
 * without further round-trips.
 */
import { requireAuth } from '~~/server/utils/auth'
import { authzFlowSession } from '~~/server/utils/oauth-server/flow'
import { errorMessage } from '~~/server/utils/content-strings'
import { getWorkspacePlan, hasFeature } from '~~/server/utils/license'
import { useDatabaseProvider } from '~~/server/utils/providers'

interface ConsentProject {
  id: string
  repoFullName: string | null
  eligible: boolean
  reason: string | null
}

interface ConsentWorkspace {
  id: string
  name: string | null
  slug: string | null
  role: string
  eligible: boolean
  reason: string | null
  projects: ConsentProject[]
}

export default defineEventHandler(async (event) => {
  if (useRuntimeConfig().authProvider !== 'managed') {
    throw createError({ statusCode: 404, message: 'Not found' })
  }

  const session = requireAuth(event)

  const flow = await authzFlowSession(event)
  const pending = flow.data
  if (!pending?.clientId) {
    throw createError({ statusCode: 400, message: errorMessage('oauth.flow_expired') })
  }

  const db = useDatabaseProvider()
  const workspaceRows = await db.listUserWorkspaces(session.accessToken, session.user.id)
  const assignedProjectIds = await db.listUserAssignedProjectIds(session.user.id)

  const workspaces: ConsentWorkspace[] = []
  for (const row of workspaceRows) {
    const role = ((row.workspace_members as Array<{ role?: string }> | undefined)?.[0]?.role) ?? 'member'
    const plan = getWorkspacePlan(row)
    const planOk = hasFeature(plan, 'api.mcp_cloud_oauth')
    const installOk = !!row.github_installation_id
    const workspaceReason = !installOk
      ? 'ineligible_no_installation'
      : (!planOk ? 'ineligible_plan' : null)

    const projectRows = role === 'member'
      ? (assignedProjectIds.length > 0
          ? await db.listWorkspaceProjectsByIds(row.id as string, assignedProjectIds)
          : [])
      : await db.listWorkspaceProjects(session.accessToken, row.id as string)

    const projects: ConsentProject[] = projectRows.map((project) => {
      const repoFullName = (project.repo_full_name as string | null) ?? null
      const reason = workspaceReason ?? (!repoFullName ? 'ineligible_no_repo' : null)
      return {
        id: project.id as string,
        repoFullName,
        eligible: reason === null,
        reason,
      }
    })

    workspaces.push({
      id: row.id as string,
      name: (row.name as string | null) ?? null,
      slug: (row.slug as string | null) ?? null,
      role,
      eligible: workspaceReason === null,
      reason: workspaceReason,
      projects,
    })
  }

  return {
    client: {
      // Spec requirement for CIMD: the relying party shown to the user is
      // the HOST of the client_id URL, not the self-asserted client_name.
      displayHost: pending.clientDisplayHost,
      name: pending.clientName,
      logoUri: pending.logoUri,
      loopbackOnly: pending.loopbackOnly,
    },
    scope: pending.scope,
    scopes: pending.scope.split(' '),
    workspaces,
  }
})

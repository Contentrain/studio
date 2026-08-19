/**
 * Connected apps — active OAuth grants for the remote MCP surface.
 *
 * Role matrix: owners/admins see every grant in the workspace; members see
 * only their own (a member's Claude connection is theirs to manage, not to
 * browse others').
 *
 * Returns 200 with `enabled: false` on the Supabase pair instead of a 404:
 * the panel needs to distinguish "no OAuth surface on this deployment"
 * from an error, and the response leaks nothing (session-guarded route).
 */
import { getRouterParam } from 'h3'
import { requireAuth } from '~~/server/utils/auth'
import { errorMessage } from '~~/server/utils/content-strings'
import { useDatabaseProvider } from '~~/server/utils/providers'
import { getWorkspaceOauthMonthUsage, listWorkspaceGrants } from '~~/server/utils/oauth-server/store'
import { remoteMcpResource } from '~~/server/utils/oauth-server/metadata'
import { isCimdClientId } from '~~/server/utils/oauth-server/cimd'

function hostOf(url: string | null): string | null {
  if (!url) return null
  try {
    return new URL(url).hostname
  }
  catch {
    return null
  }
}

export default defineEventHandler(async (event) => {
  const session = requireAuth(event)
  const workspaceId = getRouterParam(event, 'workspaceId')
  if (!workspaceId) {
    throw createError({ statusCode: 400, message: errorMessage('validation.workspace_id_required') })
  }

  const db = useDatabaseProvider()
  const role = await db.requireWorkspaceRole(session.accessToken, session.user.id, workspaceId, ['owner', 'admin', 'member'])

  if (useRuntimeConfig().authProvider !== 'managed') {
    return { enabled: false, endpoint: null, grants: [] }
  }

  const all = await listWorkspaceGrants(workspaceId)
  const visible = role === 'member'
    ? all.filter(grant => grant.userId === session.user.id)
    : all

  const month = new Date().toISOString().slice(0, 7)
  const usage = await getWorkspaceOauthMonthUsage(workspaceId, month)

  return {
    enabled: true,
    endpoint: remoteMcpResource(),
    grants: visible.map(grant => ({
      grantId: grant.grantId,
      // CIMD identity is the client_id URL's host (self-asserted names are
      // secondary); DCR falls back to client_uri host, then client_name.
      clientHost: isCimdClientId(grant.clientId)
        ? hostOf(grant.clientId)
        : (hostOf(grant.clientUri) ?? grant.clientName ?? 'Unknown application'),
      clientName: grant.clientName,
      logoUri: grant.logoUri,
      projectId: grant.projectId,
      projectRepo: grant.projectRepo,
      scopes: grant.scope.split(' '),
      createdAt: grant.createdAt,
      lastUsedAt: grant.lastUsedAt,
      callsThisMonth: usage[grant.grantId] ?? 0,
      mine: grant.userId === session.user.id,
    })),
  }
})

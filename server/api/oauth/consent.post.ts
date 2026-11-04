/**
 * POST /api/oauth/consent — the user's approve/deny decision.
 *
 * Approve re-validates everything server-side (project access, installation,
 * plan gate) before minting the authorization code; the grant row itself is
 * created at token-exchange time (the code carries the full context), so an
 * abandoned dance leaves nothing behind but a 120s code.
 *
 * Returns `{ redirectTo }` for the page to perform as a top-level
 * navigation — client redirect URIs are frequently `http://localhost:*`
 * loopbacks that only a real browser navigation can reach.
 */
import { getHeader, readBody } from 'h3'
import { requireAuth } from '~~/server/utils/auth'
import { authzFlowSession } from '~~/server/utils/oauth-server/flow'
import { createAuthorizationCode } from '~~/server/utils/oauth-server/store'
import { errorMessage } from '~~/server/utils/content-strings'
import { hasFeature } from '~~/server/utils/license'
import { resolveWorkspaceBilling } from '~~/server/utils/workspace-billing'
import { useDatabaseProvider } from '~~/server/utils/providers'
import { requireProjectAccess } from '~~/server/utils/db'
import { canonicalSiteUrl } from '~~/server/utils/oauth-server/metadata'
import { withoutMediaScopes } from '~~/server/utils/oauth-server/scopes'
import { projectMediaEligible } from '~~/server/utils/media-eligibility'

function clientRedirect(redirectUri: string, params: Record<string, string | null>): string {
  const target = new URL(redirectUri)
  for (const [key, value] of Object.entries(params)) {
    if (value !== null) target.searchParams.set(key, value)
  }
  return target.toString()
}

export default defineEventHandler(async (event) => {
  if (useRuntimeConfig().authProvider !== 'managed') {
    throw createError({ statusCode: 404, message: 'Not found' })
  }

  const session = requireAuth(event)

  // Belt-and-braces CSRF hardening on top of the SameSite cookie: the
  // decision must originate from our own origin.
  const origin = getHeader(event, 'origin')
  if (origin && origin.replace(/\/+$/, '') !== canonicalSiteUrl()) {
    throw createError({ statusCode: 403, message: errorMessage('oauth.invalid_request') })
  }

  const flow = await authzFlowSession(event)
  const pending = flow.data
  if (!pending?.clientId) {
    throw createError({ statusCode: 400, message: errorMessage('oauth.flow_expired') })
  }

  const body = await readBody<{ decision?: string, workspaceId?: string, projectId?: string }>(event)

  if (body?.decision === 'deny') {
    await flow.clear()
    return {
      redirectTo: clientRedirect(pending.redirectUri, {
        error: 'access_denied',
        state: pending.state,
      }),
    }
  }

  if (body?.decision !== 'approve' || !body.workspaceId || !body.projectId) {
    throw createError({ statusCode: 400, message: errorMessage('oauth.invalid_request') })
  }

  // Re-validate the selection server-side — the GET's eligibility flags are
  // advisory UI state, not authorization.
  await requireProjectAccess(session.user.id, body.workspaceId, body.projectId, session.accessToken)

  const db = useDatabaseProvider()
  const project = await db.getProjectById(body.projectId, 'id, repo_full_name, workspace_id, cdn_enabled')
  if (!project || project.workspace_id !== body.workspaceId || !project.repo_full_name) {
    throw createError({ statusCode: 400, message: errorMessage('oauth.project_ineligible') })
  }

  const workspace = await db.getWorkspaceById(body.workspaceId, 'id, github_installation_id, type, plan, overage_settings, owner_id')
  if (!workspace?.github_installation_id) {
    throw createError({ statusCode: 400, message: errorMessage('oauth.project_ineligible') })
  }
  // Same billing-derived plan the MCP OAuth route gates on — consent must
  // not grant what the route will then refuse.
  const plan = (await resolveWorkspaceBilling(db, workspace as { id: string }, { requireAccess: true })).effectivePlan
  if (!hasFeature(plan, 'api.mcp_cloud_oauth')) {
    throw createError({ statusCode: 403, message: errorMessage('oauth.plan_required') })
  }

  // Grant media:* only where this project can use it (the proxy's own
  // eligibility): the challenge asks for media on every media deployment,
  // and a grant should not carry URL ingest + delete it cannot reach. The
  // token response carries this narrowed scope. A project that becomes
  // eligible later needs a reconnect.
  const mediaEligible = projectMediaEligible({
    plan,
    cdnEnabled: project.cdn_enabled === true,
    mediaOwnerId: (workspace.owner_id as string | null) ?? null,
  })
  const scope = mediaEligible ? pending.scope : withoutMediaScopes(pending.scope)

  const code = await createAuthorizationCode({
    clientId: pending.clientId,
    userId: session.user.id,
    workspaceId: body.workspaceId,
    projectId: body.projectId,
    redirectUri: pending.redirectUri,
    scope,
    codeChallenge: pending.codeChallenge,
    resource: pending.resource,
  })

  await flow.clear()

  return {
    redirectTo: clientRedirect(pending.redirectUri, {
      code,
      state: pending.state,
    }),
  }
})

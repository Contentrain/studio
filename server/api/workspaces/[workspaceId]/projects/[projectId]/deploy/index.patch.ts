/**
 * Set or update the project's deploy hook. Workspace owner/admin.
 * The URL is validated (https, public host), encrypted and stored; the
 * response carries only a hint.
 *
 * PATCH /api/workspaces/{workspaceId}/projects/{projectId}/deploy
 * body { provider?: 'netlify'|'vercel'|'cloudflare-pages'|'generic', hookUrl?: string, triggers?: { on_publish?, on_schedule? } }
 */

import { encodeDeployTarget, isDeployProvider, readStoredDeployTarget, toPublicDeployTarget } from '~~/server/utils/deploy-hooks'

export default defineEventHandler(async (event) => {
  const session = requireAuth(event)
  const workspaceId = getRouterParam(event, 'workspaceId')
  const projectId = getRouterParam(event, 'projectId')
  if (!workspaceId || !projectId)
    throw createError({ statusCode: 400, message: errorMessage('validation.project_id_required') })

  const db = useDatabaseProvider()
  await db.requireWorkspaceRole(session.accessToken, session.user.id, workspaceId, ['owner', 'admin'])
  const project = await db.getProjectForWorkspace(session.accessToken, workspaceId, projectId, 'id, deploy_target')
  if (!project)
    throw createError({ statusCode: 404, message: errorMessage('project.not_found') })

  const body = await readBody<{ provider?: unknown, hookUrl?: unknown, triggers?: { on_publish?: unknown, on_schedule?: unknown } }>(event)
  const previous = readStoredDeployTarget(project.deploy_target)

  const provider = body?.provider ?? previous?.provider ?? 'generic'
  if (!isDeployProvider(provider))
    throw createError({ statusCode: 400, message: errorMessage('deploy.provider_invalid') })

  const triggers = {
    on_publish: typeof body?.triggers?.on_publish === 'boolean' ? body.triggers.on_publish : undefined,
    on_schedule: typeof body?.triggers?.on_schedule === 'boolean' ? body.triggers.on_schedule : undefined,
  }

  let next
  if (typeof body?.hookUrl === 'string' && body.hookUrl.trim()) {
    next = encodeDeployTarget({ provider, hookUrl: body.hookUrl, triggers }, previous)
  }
  else if (previous) {
    // Update provider/triggers only; keep the stored (encrypted) URL.
    next = {
      ...previous,
      provider,
      triggers: {
        on_publish: triggers.on_publish ?? previous.triggers.on_publish,
        on_schedule: triggers.on_schedule ?? previous.triggers.on_schedule,
      },
      updated_at: new Date().toISOString(),
    }
  }
  else {
    throw createError({ statusCode: 400, message: errorMessage('deploy.hook_url_invalid') })
  }

  await db.setProjectDeployTarget(projectId, next as unknown as Record<string, unknown>)
  return { target: toPublicDeployTarget(next) }
})

import { connectWorkspaceProject } from '~~/server/utils/project-connect'

export default defineEventHandler(async (event) => {
  const session = requireAuth(event)
  const workspaceId = getRouterParam(event, 'workspaceId')
  const body = await readBody<{
    repoFullName: string
    defaultBranch?: string
    contentRoot?: string
    detectedStack?: string
    hasContentrain?: boolean
  }>(event)

  if (!workspaceId)
    throw createError({ statusCode: 400, message: errorMessage('validation.workspace_id_required') })

  return connectWorkspaceProject(session.accessToken, workspaceId, event.context.billing?.effectivePlan, body)
})

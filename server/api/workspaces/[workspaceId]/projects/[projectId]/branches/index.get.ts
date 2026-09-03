import { parseBranchName } from '../../../../../../../shared/utils/branch-review'

/**
 * List cr/* branches (pending content changes).
 *
 * Each row is resolved into the change it represents — which model, which
 * locale, when — because the sidebar renders these directly and a branch name
 * (`cr/content/plans/en/1755612345-a3f2`) is not something an editor reads.
 * The model's display name comes from the brain snapshot, which is already
 * warm for any project whose panel is open.
 */
export default defineEventHandler(async (event) => {
  const session = requireAuth(event)
  const workspaceId = getRouterParam(event, 'workspaceId')
  const projectId = getRouterParam(event, 'projectId')

  if (!workspaceId || !projectId)
    throw createError({ statusCode: 400, message: errorMessage('validation.project_id_required') })

  await requireProjectAccess(session.user.id, workspaceId, projectId, session.accessToken)
  const { git, contentRoot } = await resolveProjectContext(workspaceId, projectId)

  const branches = await git.listBranches('cr/')
  if (branches.length === 0) return { branches: [] }

  // Best-effort: a project whose content branch is not readable yet still gets
  // its pending list, just without model names.
  let models: Map<string, { name?: string }> | null = null
  try {
    models = (await getOrBuildBrainCache(git, contentRoot, projectId)).models
  }
  catch {
    models = null
  }

  const requested = new Set((await useDatabaseProvider().listBranchChangeRequests(projectId).catch(() => [])).map(r => String(r.branch)))

  return {
    branches: branches.map((branch) => {
      const parsed = parseBranchName(branch.name)
      const namesModel = parsed.scope === 'content' || parsed.scope === 'model'
      const modelId = namesModel ? parsed.target : null
      return {
        name: branch.name,
        sha: branch.sha,
        protected: branch.protected,
        scope: parsed.scope,
        modelId,
        modelName: modelId ? (models?.get(modelId)?.name ?? modelId) : null,
        locale: parsed.locale,
        timestamp: parsed.timestamp,
        changesRequested: requested.has(branch.name),
      }
    }),
  }
})

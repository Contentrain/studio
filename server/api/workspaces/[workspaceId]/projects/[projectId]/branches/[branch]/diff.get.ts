import { buildBranchReview } from '../../../../../../../../server/utils/branch-review'

/**
 * What a pending content branch changes, as an editor reads it.
 *
 * The default response is a semantic review — entries, their changed fields,
 * status transitions — built by `buildBranchReview` from the project's own
 * models. It used to be a git diff: a file list plus every changed file's full
 * before/after bytes, which the panel could only render as raw JSON and which
 * shipped megabytes to describe a one-word edit.
 *
 * `?raw=1` still returns that file-level shape. It backs the panel's technical
 * view, so the whole-file reads only happen when someone asks for them.
 */
export default defineEventHandler(async (event) => {
  const session = requireAuth(event)
  const workspaceId = getRouterParam(event, 'workspaceId')
  const projectId = getRouterParam(event, 'projectId')
  // cr/* branch names contain slashes, so the client sends them
  // percent-encoded; without { decode: true } the raw "cr%2F..." fails the
  // startsWith('cr/') guard and would be passed verbatim to the Git API.
  const branch = getRouterParam(event, 'branch', { decode: true })

  if (!workspaceId || !projectId || !branch)
    throw createError({ statusCode: 400, message: errorMessage('validation.branch_params_required') })

  // Only cr/* branches can be diffed through Studio
  if (!branch.startsWith('cr/'))
    throw createError({ statusCode: 400, message: errorMessage('branches.contentrain_only') })

  await requireProjectAccess(session.user.id, workspaceId, projectId, session.accessToken)
  const { git, contentRoot } = await resolveProjectContext(workspaceId, projectId)

  // Diff against contentrain branch (cr/* branches are created from contentrain)
  const baseBranch = 'contentrain'
  const files = await git.getBranchDiff(branch, baseBranch)

  const read = async (path: string, ref: string): Promise<string | null> => {
    try {
      return await git.readFile(path, ref)
    }
    catch {
      // The file does not exist at that ref — a create or a delete, not an error.
      return null
    }
  }

  if (getQuery(event).raw) {
    const contents: Record<string, { before: unknown, after: unknown }> = {}
    for (const file of files) {
      const parse = (raw: string | null) =>
        raw === null ? null : file.path.endsWith('.json') ? safeJson(raw) : raw
      contents[file.path] = {
        before: file.status === 'added' ? null : parse(await read(file.path, baseBranch)),
        after: file.status === 'removed' ? null : parse(await read(file.path, branch)),
      }
    }
    return { branch, files, contents }
  }

  const brain = await getOrBuildBrainCache(git, contentRoot, projectId)

  // The same gate the merge and reject routes enforce, resolved once here so
  // the panel can hide an action instead of offering one that answers 403.
  const permissions = await resolveAgentPermissions(session.user.id, workspaceId, projectId, session.accessToken)

  return await buildBranchReview({
    branch,
    files,
    read,
    baseRef: baseBranch,
    branchRef: branch,
    models: brain.models,
    config: brain.config,
    contentRoot,
    relationSource: (modelId, locale) => brain.content.get(`${modelId}:${locale}`) ?? null,
    canMerge: permissions.availableTools.includes('merge_branch'),
    canReject: permissions.availableTools.includes('reject_branch'),
  })
})

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw)
  }
  catch {
    return raw
  }
}

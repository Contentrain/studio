/**
 * Get diff for a content branch compared to the default branch.
 * Returns file-level diffs with before/after content for JSON files.
 */
export default defineEventHandler(async (event) => {
  const session = requireAuth(event)
  const workspaceId = getRouterParam(event, 'workspaceId')
  const projectId = getRouterParam(event, 'projectId')
  const branch = getRouterParam(event, 'branch')

  if (!workspaceId || !projectId || !branch)
    throw createError({ statusCode: 400, message: errorMessage('validation.branch_params_required') })

  // Only cr/* branches can be diffed through Studio
  if (!branch.startsWith('cr/'))
    throw createError({ statusCode: 400, message: errorMessage('branches.contentrain_only') })

  const { git } = await resolveProjectContext(
    useSupabaseUserClient(session.accessToken), workspaceId, projectId,
  )

  // Diff against contentrain branch (cr/* branches are created from contentrain)
  const baseBranch = 'contentrain'
  const files = await git.getBranchDiff(branch, baseBranch)

  // Load before/after content for each changed file
  const contents: Record<string, { before: unknown, after: unknown }> = {}

  for (const file of files) {
    let before: unknown = null
    let after: unknown = null

    if (file.status !== 'added') {
      try {
        const raw = await git.readFile(file.path, baseBranch)
        before = file.path.endsWith('.json') ? JSON.parse(raw) : raw
      }
      catch { /* file may not exist on base branch */ }
    }

    if (file.status !== 'removed') {
      try {
        const raw = await git.readFile(file.path, branch)
        after = file.path.endsWith('.json') ? JSON.parse(raw) : raw
      }
      catch { /* file may not exist on branch */ }
    }

    contents[file.path] = { before, after }
  }

  return { branch, files, contents }
})

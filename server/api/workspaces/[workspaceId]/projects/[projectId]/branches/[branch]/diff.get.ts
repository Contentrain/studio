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

  // Only contentrain/* branches can be diffed through Studio
  if (!branch.startsWith('contentrain/'))
    throw createError({ statusCode: 400, message: errorMessage('branches.contentrain_only') })

  const { git } = await resolveProjectContext(
    useSupabaseUserClient(session.accessToken), workspaceId, projectId,
  )

  const files = await git.getBranchDiff(branch)

  // Load before/after content for each changed file
  const contents: Record<string, { before: unknown, after: unknown }> = {}
  const defaultBranch = await git.getDefaultBranch()

  for (const file of files) {
    let before: unknown = null
    let after: unknown = null

    if (file.status !== 'added') {
      try {
        const raw = await git.readFile(file.path, defaultBranch)
        before = file.path.endsWith('.json') ? JSON.parse(raw) : raw
      }
      catch { /* file may not exist on default branch */ }
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

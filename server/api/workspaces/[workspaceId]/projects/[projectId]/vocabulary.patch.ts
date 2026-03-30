/**
 * Update .contentrain/vocabulary.json terms.
 * Merges provided terms with existing. Set a term value to null to delete it.
 * Always auto-merges.
 */
export default defineEventHandler(async (event) => {
  const session = requireAuth(event)
  const db = useDatabaseProvider()
  const workspaceId = getRouterParam(event, 'workspaceId')
  const projectId = getRouterParam(event, 'projectId')
  const body = await readBody<{ terms: Record<string, Record<string, string> | null> }>(event)

  if (!workspaceId || !projectId)
    throw createError({ statusCode: 400, message: errorMessage('validation.project_id_required') })

  if (!body.terms || typeof body.terms !== 'object')
    throw createError({ statusCode: 400, message: errorMessage('validation.terms_required') })

  // Editor+ required to modify vocabulary (viewer/reviewer cannot write)
  const permissions = await resolveAgentPermissions(session.user.id, workspaceId, projectId, session.accessToken)
  if (!permissions.availableTools.includes('save_content'))
    throw createError({ statusCode: 403, message: errorMessage('vocabulary.modify_forbidden') })

  const { git, contentRoot } = await resolveProjectContext(
    db.getUserClient(session.accessToken), workspaceId, projectId,
  )

  const vocabPath = contentRoot ? `${contentRoot}/.contentrain/vocabulary.json` : '.contentrain/vocabulary.json'

  // Read current vocabulary
  let vocabulary: { version: number, terms: Record<string, Record<string, string>> } = { version: 1, terms: {} }
  try {
    vocabulary = JSON.parse(await git.readFile(vocabPath, 'contentrain')) as typeof vocabulary
  }
  catch { /* no existing vocabulary */ }

  // Merge terms (null = delete)
  const updatedTerms: Record<string, Record<string, string>> = {}
  for (const [key, existing] of Object.entries(vocabulary.terms)) {
    if (!(key in body.terms) || body.terms[key] !== null) {
      updatedTerms[key] = existing
    }
  }
  for (const [key, value] of Object.entries(body.terms)) {
    if (value !== null) {
      updatedTerms[key] = { ...(updatedTerms[key] ?? {}), ...value }
    }
  }
  vocabulary.terms = updatedTerms

  // Use content engine for branch lifecycle (ensureContentBranch + merge)
  const engine = createContentEngine({ git, contentRoot })
  await engine.ensureContentBranch()

  // Commit + auto-merge
  const branchName = generateBranchName('content', 'vocabulary')
  await git.createBranch(branchName, 'contentrain')

  await git.commitFiles(
    branchName,
    [{ path: vocabPath, content: `${JSON.stringify(vocabulary, null, 2)}\n` }],
    'contentrain: update vocabulary',
    { name: 'Contentrain Studio[bot]', email: 'bot@contentrain.io' },
  )

  const mergeResult = await engine.mergeBranch(branchName)

  // Invalidate brain cache so next read picks up new vocabulary
  invalidateBrainCache(projectId)

  return { vocabulary, merged: mergeResult.merged }
})

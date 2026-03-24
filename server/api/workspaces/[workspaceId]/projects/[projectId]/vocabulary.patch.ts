/**
 * Update .contentrain/vocabulary.json terms.
 * Merges provided terms with existing. Set a term value to null to delete it.
 * Always auto-merges.
 */
export default defineEventHandler(async (event) => {
  const session = requireAuth(event)
  const workspaceId = getRouterParam(event, 'workspaceId')
  const projectId = getRouterParam(event, 'projectId')
  const body = await readBody<{ terms: Record<string, Record<string, string> | null> }>(event)

  if (!workspaceId || !projectId)
    throw createError({ statusCode: 400, message: 'workspaceId and projectId are required' })

  if (!body.terms || typeof body.terms !== 'object')
    throw createError({ statusCode: 400, message: 'terms object is required' })

  // Editor+ required to modify vocabulary (viewer/reviewer cannot write)
  const permissions = await resolveAgentPermissions(session.user.id, workspaceId, projectId, session.accessToken)
  if (!permissions.availableTools.includes('save_content'))
    throw createError({ statusCode: 403, message: 'Insufficient permissions to modify vocabulary' })

  const { git, contentRoot } = await resolveProjectContext(
    useSupabaseUserClient(session.accessToken), workspaceId, projectId,
  )

  const vocabPath = contentRoot ? `${contentRoot}/.contentrain/vocabulary.json` : '.contentrain/vocabulary.json'

  // Read current vocabulary
  let vocabulary: { version: number, terms: Record<string, Record<string, string>> } = { version: 1, terms: {} }
  try {
    vocabulary = JSON.parse(await git.readFile(vocabPath)) as typeof vocabulary
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

  // Commit + auto-merge
  const branchName = `contentrain/vocab-${Date.now().toString(36)}`
  await git.createBranch(branchName)

  await git.commitFiles(
    branchName,
    [{ path: vocabPath, content: `${JSON.stringify(vocabulary, null, 2)}\n` }],
    'contentrain: update vocabulary',
    { name: 'Contentrain Studio[bot]', email: 'bot@contentrain.io' },
  )

  // Use content engine merge (has PR fallback for protected branches)
  const engine = createContentEngine({ git, contentRoot })
  const mergeResult = await engine.mergeBranch(branchName)

  return { vocabulary, merged: mergeResult.merged }
})

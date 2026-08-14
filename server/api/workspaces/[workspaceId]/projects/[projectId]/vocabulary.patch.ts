/**
 * Update .contentrain/vocabulary.json terms.
 * Merges provided terms with existing. Set a term value to null to delete it.
 * Always auto-merges.
 *
 * This is a read-modify-write over a whole file, so it needs concurrency
 * control: the vocabulary UI saves once per term, and two saves a few seconds
 * apart used to fork the same `contentrain` commit, each write the entire file
 * from that same base, and merge one after another — the last snapshot won and
 * silently dropped the other's term. The endpoint reported success either way,
 * so the term reappeared until the next refresh and a `cr/*` branch was left
 * behind on the merges that did conflict.
 *
 * The write is therefore verified rather than assumed: after merging we re-read
 * `contentrain` and check the caller's intent actually survived, retrying from
 * a fresh read when it didn't. Reads are not memoized on this provider, so the
 * verification sees real state.
 */

import type { TermPatch, Vocabulary } from '~~/server/utils/vocabulary-merge'
import { applyVocabularyPatch, vocabularyPatchSatisfied } from '~~/server/utils/vocabulary-merge'

const CONTENT_BRANCH = 'contentrain'
const MAX_ATTEMPTS = 3

function isNotFound(err: unknown): boolean {
  return (err as { status?: number }).status === 404
}

export default defineEventHandler(async (event) => {
  const session = requireAuth(event)
  const workspaceId = getRouterParam(event, 'workspaceId')
  const projectId = getRouterParam(event, 'projectId')
  const body = await readBody<{ terms: TermPatch }>(event)

  if (!workspaceId || !projectId)
    throw createError({ statusCode: 400, message: errorMessage('validation.project_id_required') })

  if (!body.terms || typeof body.terms !== 'object')
    throw createError({ statusCode: 400, message: errorMessage('validation.terms_required') })

  // Editor+ required to modify vocabulary (viewer/reviewer cannot write)
  const permissions = await resolveAgentPermissions(session.user.id, workspaceId, projectId, session.accessToken)
  if (!permissions.availableTools.includes('save_content'))
    throw createError({ statusCode: 403, message: errorMessage('vocabulary.modify_forbidden') })

  const { git, contentRoot } = await resolveProjectContext(workspaceId, projectId)
  const vocabPath = contentRoot ? `${contentRoot}/.contentrain/vocabulary.json` : '.contentrain/vocabulary.json'

  /**
   * A missing file is a legitimate starting point; anything else is not.
   * Swallowing a read failure here would silently drop every existing term
   * and write the result back as the new truth.
   */
  async function readVocabulary(): Promise<Vocabulary> {
    try {
      return JSON.parse(await git.readFile(vocabPath, CONTENT_BRANCH)) as Vocabulary
    }
    catch (err) {
      if (isNotFound(err)) return { version: 1, terms: {} }
      throw createError({ statusCode: 502, message: errorMessage('vocabulary.read_failed') })
    }
  }

  const engine = createContentEngine({ git, contentRoot, projectId })
  await engine.ensureContentBranch()

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const vocabulary = applyVocabularyPatch(await readVocabulary(), body.terms)

    // `applyPlan` forks `base` when the branch is missing — no separate
    // createBranch, matching every other write path in the content engine.
    const branchName = generateBranchName('content', 'vocabulary')
    await git.applyPlan({
      branch: branchName,
      changes: [{ path: vocabPath, content: `${JSON.stringify(vocabulary, null, 2)}\n` }],
      message: 'contentrain: update vocabulary',
      author: { name: 'Contentrain Studio', email: 'ai@contentrain.io' },
      base: CONTENT_BRANCH,
    })

    let mergeResult: { merged: boolean, pullRequestUrl?: string | null }
    try {
      mergeResult = await engine.mergeBranch(branchName)
    }
    catch (err) {
      // GitHub's merge endpoint answers a real conflict with 409 and the
      // provider re-throws it (only "already merged" is absorbed) — so the
      // concurrent-writer conflict this loop exists for used to arrive as
      // an exception, escape the loop, and reach the UI as an unhandled
      // 500 (staging, 2026-08-13 14:04Z). Treat it as the retryable
      // conflict it is.
      const status = err as { status?: number, statusCode?: number }
      if (status.status === 409 || status.statusCode === 409) {
        await git.deleteBranch(branchName).catch(() => { /* best-effort */ })
        continue
      }
      throw err
    }

    if (!mergeResult.merged && !mergeResult.pullRequestUrl) {
      // A concurrent write landed first and this one conflicts. Drop the
      // branch so it doesn't accumulate, then retry from fresh state.
      await git.deleteBranch(branchName).catch(() => { /* best-effort */ })
      continue
    }

    // Merged — or landed on `contentrain` with a PR fallback toward a
    // protected main. Either way the vocabulary IS on `contentrain`
    // (which is exactly what the verification below reads), so a PR
    // fallback must not loop back into another identical write.

    invalidateBrainCache(projectId)

    // The merge can succeed and still lose the term, when the other writer
    // forked the same base and merged last. Verify before reporting success.
    const landed = await readVocabulary()
    if (vocabularyPatchSatisfied(landed, body.terms)) {
      return { vocabulary: landed, merged: true }
    }
  }

  invalidateBrainCache(projectId)
  throw createError({ statusCode: 409, message: errorMessage('vocabulary.save_conflict') })
})

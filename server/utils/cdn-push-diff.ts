/**
 * Changed-path resolution for webhook-triggered CDN builds.
 *
 * Push payload `commits[].added/modified/removed` is NOT a reliable diff
 * source: GitHub caps the commits array, merge commits arrive with empty
 * file arrays, and only commits newly reachable from the pushed ref carry
 * their file lists at all — so a merge whose content commits were already
 * reachable (PR-fallback landings, re-merges) shows nothing but a
 * `context.json` regeneration, which used to defeat the empty→full-rebuild
 * fallback (issue #133). Force pushes lie in the other direction.
 *
 * Instead the true `before...after` diff is resolved through the Compare
 * API. Every ambiguity degrades to a FULL rebuild — over-building is stale-
 * content-safe, under-building is not.
 */

const ZERO_SHA = /^0+$/

/**
 * GitHub's compare endpoint returns at most 300 files and offers no
 * total count — a response at the cap must be treated as truncated.
 */
const COMPARE_FILES_CAP = 300

export interface PushDiffDecision {
  /** `skip` = the push changed nothing — don't create a build at all. */
  action: 'build' | 'skip'
  /** Precise changed paths — only set when the compare fully succeeded. */
  changedPaths?: string[]
  /** Set when the diff could not be resolved reliably. */
  fullRebuild?: boolean
}

export async function resolvePushDiff(input: {
  before?: string
  after?: string
  getDiff: (head: string, base: string) => Promise<Array<{ path: string }>>
}): Promise<PushDiffDecision> {
  const { before, after } = input

  // Ref deleted — nothing to serve from this push.
  if (!after || ZERO_SHA.test(after))
    return { action: 'skip' }

  // Ref created (or payload missing `before`) — no base to diff against.
  if (!before || ZERO_SHA.test(before))
    return { action: 'build', fullRebuild: true }

  try {
    const files = await input.getDiff(after, before)

    if (files.length >= COMPARE_FILES_CAP)
      return { action: 'build', fullRebuild: true }

    // Ref moved but the tree is identical (e.g. a no-op force push).
    if (files.length === 0)
      return { action: 'skip' }

    return { action: 'build', changedPaths: files.map(f => f.path) }
  }
  catch {
    // Transient API failure — a wasted full build beats stale delivery.
    return { action: 'build', fullRebuild: true }
  }
}

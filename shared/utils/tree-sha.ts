/**
 * The brain's content-version token, and what counts as one.
 *
 * The server mints it (`server/utils/brain-cache.ts:computeTreeHash`, a
 * sha-256 over the tracked file set) and the client stores it in IndexedDB and
 * hands it back on the next sync as its cache key. Neither side reads anything
 * out of it — it is compared whole — so the only contract between them is its
 * shape, which is what lives here.
 */

/** A token this build minted: sha-256, lower-case hex. */
export const TREE_SHA_RE = /^[0-9a-f]{64}$/

/**
 * The token to send back, or `null` to ask for a full sync.
 *
 * Studio used to mint a token that was the whole `path:sha|…` join, so its
 * length grew with the repo — measured on staging, 54 files produced 4,404
 * characters. That token travels in a URL, and past roughly 14 KB of query
 * string the request is rejected with 431 before any handler runs (measured:
 * 150 files answered 200, 160 answered 431).
 *
 * Browsers that used Studio before the change still hold one. Sending it back
 * is worse than sending nothing: on a large project the request 431s, the sync
 * lands in its catch, and the stored token is never replaced — so it would
 * fail again on every load, forever. Declining to send an unrecognised token
 * costs exactly one full sync, whose response overwrites it.
 */
export function usableTreeSha(value: string | null | undefined): string | null {
  return typeof value === 'string' && TREE_SHA_RE.test(value) ? value : null
}

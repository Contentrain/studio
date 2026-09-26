/**
 * The dictionary key naming what kind of change a `cr/{scope}/…` branch
 * carries, for when there is no model name to show instead.
 *
 * The scopes are the ones MCP's `buildBranchName` and Studio's own write paths
 * produce. Anything else reads as a plain "Change" — building the key from the
 * scope itself put `review.scope_media` on screen the day the media switch
 * started opening branches.
 */
const SCOPE_KEYS = new Map<string, string>(Object.entries({
  bulk: 'review.scope_bulk',
  config: 'review.scope_config',
  content: 'review.scope_content',
  fix: 'review.scope_fix',
  media: 'review.scope_media',
  model: 'review.scope_model',
  new: 'review.scope_new',
  normalize: 'review.scope_normalize',
}))

export function reviewScopeKey(scope: string | null | undefined): string {
  return (scope && SCOPE_KEYS.get(scope)) || 'review.scope_other'
}

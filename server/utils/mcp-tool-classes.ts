/**
 * Tool classification for the MCP Cloud surfaces — single source for the
 * proxy pipeline (write detection) and the OAuth scope registry (scope →
 * tool derivation). Deliberately dependency-free beyond MCP's annotation
 * and availability exports so the scope module stays importable from
 * plain unit tests.
 */
import { TOOL_ANNOTATIONS } from '@contentrain/mcp/tools/annotations'
import { TOOL_REQUIREMENTS } from '@contentrain/mcp/tools/availability'

/**
 * Merge/review lifecycle is Studio-owned: these tools are capability-gated
 * on the loopback server (no `localWorktree`) and must never trigger
 * brain invalidation or auto-merge reconciliation, even though MCP's
 * annotations mark some of them as writes. No OAuth scope grants them.
 */
export const STUDIO_OWNED_LIFECYCLE_TOOLS = new Set([
  'contentrain_merge',
  'contentrain_branch_list',
  'contentrain_branch_delete',
  'contentrain_submit',
])

/**
 * Media tools (1.10.0) — derived from MCP's own availability contract
 * (`TOOL_REQUIREMENTS[tool].media`). They pass through to the provider's
 * media facet and NEVER touch the content branch, so they are excluded
 * from the write set (no brain invalidation, no auto-merge reconcile) and
 * from the content scopes (they map to `media:read` / `media:write`).
 * The loopback provider attaches the facet only for media-eligible
 * sessions (media stack + plan + cdn_enabled); when absent, the MCP
 * server hides these tools from tools/list — but the classification is
 * always correct, so the key gate and scope mapping hold either way.
 */
export const MEDIA_TOOL_NAMES = new Set(
  Object.entries(TOOL_REQUIREMENTS)
    .filter(([, requirement]) => (requirement as { media?: boolean }).media === true)
    .map(([name]) => name),
)

export const MEDIA_READ_TOOL_NAMES = new Set(
  [...MEDIA_TOOL_NAMES].filter(name => TOOL_ANNOTATIONS[name]?.readOnlyHint === true),
)

export const MEDIA_WRITE_TOOL_NAMES = new Set(
  [...MEDIA_TOOL_NAMES].filter(name => TOOL_ANNOTATIONS[name]?.readOnlyHint !== true),
)

/**
 * Tools whose effects can land on the content branch — derived from MCP's
 * own annotations (`readOnlyHint: false`) so a future MCP release that
 * opens e.g. `contentrain_bulk` to remote providers is covered without a
 * Studio change. Lifecycle tools are excluded (Studio owns that path) and
 * so are media writes (they go through the media service, not git).
 * Tools that are still localWorktree-gated merely cost a harmless no-op
 * reconcile if invoked.
 */
export const WRITE_TOOL_NAMES = new Set(
  Object.entries(TOOL_ANNOTATIONS)
    .filter(([name, annotation]) => annotation.readOnlyHint !== true
      && !STUDIO_OWNED_LIFECYCLE_TOOLS.has(name)
      && !MEDIA_TOOL_NAMES.has(name))
    .map(([name]) => name),
)

/** Project-structure reads — gated by the `project:metadata` scope. */
export const METADATA_TOOL_NAMES = new Set([
  'contentrain_status',
  'contentrain_describe',
  'contentrain_describe_format',
])

/**
 * Content reads — every readOnly tool that is neither lifecycle nor
 * metadata nor media (content_list, validate, scan, doctor, …).
 */
export const READ_TOOL_NAMES = new Set(
  Object.entries(TOOL_ANNOTATIONS)
    .filter(([name, annotation]) => annotation.readOnlyHint === true
      && !STUDIO_OWNED_LIFECYCLE_TOOLS.has(name)
      && !METADATA_TOOL_NAMES.has(name)
      && !MEDIA_TOOL_NAMES.has(name))
    .map(([name]) => name),
)

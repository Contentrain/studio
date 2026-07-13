/**
 * Tool classification for the MCP Cloud surfaces — single source for the
 * proxy pipeline (write detection) and the OAuth scope registry (scope →
 * tool derivation). Deliberately dependency-free beyond MCP's annotations
 * so the scope module stays importable from plain unit tests.
 */
import { TOOL_ANNOTATIONS } from '@contentrain/mcp/tools/annotations'

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
 * Tools whose effects can land on the content branch — derived from MCP's
 * own annotations (`readOnlyHint: false`) so a future MCP release that
 * opens e.g. `contentrain_bulk` to remote providers is covered without a
 * Studio change. Tools that are still localWorktree-gated merely cost a
 * harmless no-op reconcile if invoked.
 */
export const WRITE_TOOL_NAMES = new Set(
  Object.entries(TOOL_ANNOTATIONS)
    .filter(([name, annotation]) => annotation.readOnlyHint !== true && !STUDIO_OWNED_LIFECYCLE_TOOLS.has(name))
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
 * metadata (content_list, validate, scan, doctor, …).
 */
export const READ_TOOL_NAMES = new Set(
  Object.entries(TOOL_ANNOTATIONS)
    .filter(([name, annotation]) => annotation.readOnlyHint === true
      && !STUDIO_OWNED_LIFECYCLE_TOOLS.has(name)
      && !METADATA_TOOL_NAMES.has(name))
    .map(([name]) => name),
)

/**
 * Scope registry for the remote MCP OAuth surface.
 *
 * Six scopes are defined; four are advertised. `media:*` maps to the
 * 1.10.0 media tools, but the loopback provider doesn't implement the
 * media facet yet — the MCP server hides those tools from tools/list
 * entirely (TOOL_REQUIREMENTS), so the scopes stay OUT of
 * `scopes_supported` until the facet ships: clients request everything a
 * server advertises, and a scope granting invisible tools is a
 * directory-review liability. Flip ADVERTISED_SCOPES when the facet lands.
 */
import { MEDIA_READ_TOOL_NAMES, MEDIA_WRITE_TOOL_NAMES, METADATA_TOOL_NAMES, READ_TOOL_NAMES, WRITE_TOOL_NAMES } from '../mcp-tool-classes'

export const SUPPORTED_SCOPES = [
  'content:read',
  'content:write',
  'project:metadata',
  'media:read',
  'media:write',
  'offline_access',
] as const

export type SupportedScope = (typeof SUPPORTED_SCOPES)[number]

/** Advertised in AS metadata + PRM. offline_access is what makes Claude request a refresh token. */
export const ADVERTISED_SCOPES: SupportedScope[] = [
  'content:read',
  'content:write',
  'project:metadata',
  'offline_access',
]

/** Scope hint on 401 challenges — the minimum a functional connection needs. */
export const CHALLENGE_SCOPES: SupportedScope[] = [
  'content:read',
  'content:write',
  'project:metadata',
]

const SUPPORTED = new Set<string>(SUPPORTED_SCOPES)

/** Requested scope absent → least-privilege default. */
const DEFAULT_SCOPE = 'content:read project:metadata'

/**
 * Validate + canonicalize a space-delimited scope request (RFC 6749 §3.3).
 * Returns the normalized scope string, or null when any member is unknown —
 * the caller maps null to `invalid_scope`.
 */
export function normalizeScope(requested: string | undefined | null): string | null {
  const trimmed = requested?.trim()
  if (!trimmed) return DEFAULT_SCOPE

  const parts = [...new Set(trimmed.split(/\s+/))]
  if (parts.some(part => !SUPPORTED.has(part))) return null

  // Canonical order = registry order, so equal scope sets compare equal.
  const ordered = SUPPORTED_SCOPES.filter(scope => parts.includes(scope))

  // offline_access alone grants nothing callable — pad with the default.
  if (ordered.every(scope => scope === 'offline_access'))
    return `${DEFAULT_SCOPE} offline_access`

  return ordered.join(' ')
}

export function scopeIncludes(scope: string, member: SupportedScope): boolean {
  return scope.split(' ').includes(member)
}

// ─── Scope → tool derivation (remote MCP surface) ───

/**
 * Which tools a grant's scope may call — feeds the proxy pipeline's
 * allowlist. Media scopes map to the 1.10.0 media tools; the tools only
 * materialize in tools/list once the loopback provider ships its media
 * facet, but the scope enforcement is already correct for that day.
 * Lifecycle tools are excluded from every scope (Studio owns the
 * merge/review lifecycle).
 */
export function toolsForScope(scope: string): string[] {
  const parts = new Set(scope.split(' '))
  const tools = new Set<string>()

  if (parts.has('project:metadata')) {
    for (const name of METADATA_TOOL_NAMES) tools.add(name)
  }
  if (parts.has('content:read')) {
    for (const name of READ_TOOL_NAMES) tools.add(name)
  }
  if (parts.has('content:write')) {
    for (const name of WRITE_TOOL_NAMES) tools.add(name)
  }
  if (parts.has('media:read')) {
    for (const name of MEDIA_READ_TOOL_NAMES) tools.add(name)
  }
  if (parts.has('media:write')) {
    for (const name of MEDIA_WRITE_TOOL_NAMES) tools.add(name)
  }

  return [...tools]
}

export function scopeAllowsTool(scope: string, tool: string): boolean {
  return toolsForScope(scope).includes(tool)
}

/**
 * The scope a denied tool would need — drives the 403 insufficient_scope
 * step-up challenge. Null for tools no scope can grant (lifecycle tools,
 * unknown names): those get a plain 403, never a step-up loop.
 */
export function scopeForTool(tool: string): SupportedScope | null {
  if (METADATA_TOOL_NAMES.has(tool)) return 'project:metadata'
  if (READ_TOOL_NAMES.has(tool)) return 'content:read'
  if (WRITE_TOOL_NAMES.has(tool)) return 'content:write'
  if (MEDIA_READ_TOOL_NAMES.has(tool)) return 'media:read'
  if (MEDIA_WRITE_TOOL_NAMES.has(tool)) return 'media:write'
  return null
}

/**
 * Runtime state for the loopback MCP Cloud HTTP server.
 *
 * The actual server is booted in `server/plugins/mcp-cloud-server.ts`
 * (Nitro auto-registered). The plugin stores the server URL here and
 * the proxy route (`server/api/mcp/v1/[projectId]/[...slug].ts`) reads
 * it. Keeping the shared state in a regular server util avoids the
 * "plugin file also exports module values" anti-pattern — Nitro
 * bundles plugins and utils through different code paths; importing
 * named values from a plugin file is brittle across builds.
 */

/**
 * Tenant fingerprint for loopback MCP sessions (1.10.0
 * `sessionFingerprint`). Derived from the SAME proxy-injected `x-cr-*`
 * headers `resolveProvider` reads, so a session created for one
 * project can never be replayed against another via a stolen
 * `Mcp-Session-Id`: a mismatch makes the loopback answer 404 and the
 * client re-initializes against its own provider.
 *
 * `x-cr-project-id` is included last: the proxy injects it only for
 * media-eligible requests, so it does double duty — (1) two projects
 * sharing a repo+root no longer share a media-capable session, and (2)
 * an eligibility flip (plan downgrade, CDN toggle, key rotation, media
 * opt-in) changes the injected header set → fingerprint mismatch → the
 * loopback 404s → the client re-initializes → tools/list reflects the
 * new facet state within a single request instead of after the 15-min
 * session TTL.
 */
export function mcpTenantFingerprint(headers: Record<string, string | string[] | undefined>): string | undefined {
  const pick = (name: string) => {
    const value = headers[name]
    return typeof value === 'string' ? value : undefined
  }

  const installationId = pick('x-cr-installation-id')
  const owner = pick('x-cr-repo-owner')
  const repo = pick('x-cr-repo-name')
  if (!installationId || !owner || !repo) return undefined

  return `${installationId}:${owner}/${repo}:${pick('x-cr-content-root') ?? ''}:${pick('x-cr-project-id') ?? ''}`
}

let mcpUrl: string | null = null
let closer: (() => Promise<void>) | null = null

export function setInternalMcp(url: string, close: () => Promise<void>): void {
  mcpUrl = url
  closer = close
}

export function getInternalMcpUrl(): string | null {
  return mcpUrl
}

export async function closeInternalMcp(): Promise<void> {
  if (closer) {
    const fn = closer
    closer = null
    mcpUrl = null
    await fn()
  }
}

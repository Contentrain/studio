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

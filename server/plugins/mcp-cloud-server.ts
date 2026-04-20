/**
 * Internal HTTP MCP server for MCP Cloud (Faz S6).
 *
 * `@contentrain/mcp/server/http:startHttpMcpServerWith` owns a full
 * `http.Server` — it cannot be embedded inside Nitro's HTTP listener
 * directly. Instead we boot a loopback-only MCP server on a random port
 * at Nitro startup; the `/api/mcp/v1/[projectId]/[...slug].ts` Nuxt route
 * acts as the public entry point (Bearer auth + plan/quota gate +
 * brain-cache invalidation) and proxies the raw HTTP request into this
 * loopback server.
 *
 * Provider resolution (`resolveProvider`) reads project identity from
 * request headers the proxy attaches — MCP Cloud never resolves the
 * target repo itself. Plaintext installation tokens never transit the
 * public boundary.
 *
 * The server URL is published through `server/utils/mcp-cloud-runtime`
 * — plugins and utils are bundled by Nitro along different paths, so
 * named exports from plugin files are unreliable in production builds.
 *
 * Boot is deliberately NON-BLOCKING: `startHttpMcpServerWith` is fired
 * without `await` so Nitro's own HTTP listener comes up immediately
 * and healthchecks pass even on cold start. The proxy route guards on
 * `getInternalMcpUrl() === null` and returns 503 until the loopback
 * server is ready — MCP clients retry on 503, so the window is benign.
 */

import { startHttpMcpServerWith } from '@contentrain/mcp/server/http'
import { createStudioGitProvider } from '../providers/git'
import { closeInternalMcp, setInternalMcp } from '../utils/mcp-cloud-runtime'

const HEADER_INSTALLATION_ID = 'x-cr-installation-id'
const HEADER_REPO_OWNER = 'x-cr-repo-owner'
const HEADER_REPO_NAME = 'x-cr-repo-name'
const HEADER_CONTENT_ROOT = 'x-cr-content-root'

export default defineNitroPlugin((nitroApp) => {
  // Fire-and-forget: we do not want to block Nitro's startup on an
  // external HTTP listener coming up. The proxy route 503s until
  // `setInternalMcp` fires.
  void bootInternalMcpServer().catch((err) => {
    // eslint-disable-next-line no-console -- background boot failure must surface somewhere
    console.error('[mcp-cloud] Failed to start internal MCP server:', err)
  })

  nitroApp.hooks.hook('close', async () => {
    await closeInternalMcp()
  })
})

async function bootInternalMcpServer(): Promise<void> {
  const handle = await startHttpMcpServerWith({
    port: 0,
    host: '127.0.0.1',
    sessionTtlMs: 15 * 60 * 1000,
    resolveProvider: (req) => {
      const headers = req.headers
      const installationIdRaw = headers[HEADER_INSTALLATION_ID]
      const owner = headers[HEADER_REPO_OWNER]
      const repo = headers[HEADER_REPO_NAME]
      const contentRoot = headers[HEADER_CONTENT_ROOT]

      if (
        typeof installationIdRaw !== 'string'
        || typeof owner !== 'string'
        || typeof repo !== 'string'
      ) {
        throw new Error('MCP Cloud: missing required project headers')
      }

      const installationId = Number.parseInt(installationIdRaw, 10)
      if (!Number.isInteger(installationId) || installationId <= 0) {
        throw new Error('MCP Cloud: invalid installation id')
      }

      return createStudioGitProvider({
        installationId,
        owner,
        repo,
        contentRoot: typeof contentRoot === 'string' && contentRoot.length > 0
          ? contentRoot
          : undefined,
      })
    },
  })

  setInternalMcp(handle.url, () => handle.close())
}

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
 * target repo itself.
 */

import { startHttpMcpServerWith } from '@contentrain/mcp/server/http'
import type { HttpMcpServerHandle } from '@contentrain/mcp/server/http'
import { createStudioGitProvider } from '../providers/git'

const HEADER_INSTALLATION_ID = 'x-cr-installation-id'
const HEADER_REPO_OWNER = 'x-cr-repo-owner'
const HEADER_REPO_NAME = 'x-cr-repo-name'
const HEADER_CONTENT_ROOT = 'x-cr-content-root'

let mcpHandle: HttpMcpServerHandle | null = null
let mcpUrl: string | null = null

/**
 * Return the internal MCP server URL (e.g. `http://127.0.0.1:53211/mcp`)
 * or `null` if the plugin has not booted yet. Route handlers guard on
 * this and return 503 when unset.
 */
export function getInternalMcpUrl(): string | null {
  return mcpUrl
}

export default defineNitroPlugin(async (nitroApp) => {
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

  mcpHandle = handle
  mcpUrl = handle.url

  nitroApp.hooks.hook('close', async () => {
    if (mcpHandle) {
      await mcpHandle.close()
      mcpHandle = null
      mcpUrl = null
    }
  })
})

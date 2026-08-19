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
import { buildMcpMediaFacet } from '../utils/mcp-media-facet'
import { closeInternalMcp, mcpTenantFingerprint, setInternalMcp } from '../utils/mcp-cloud-runtime'
import type { Plan } from '../utils/license'

const HEADER_INSTALLATION_ID = 'x-cr-installation-id'
const HEADER_REPO_OWNER = 'x-cr-repo-owner'
const HEADER_REPO_NAME = 'x-cr-repo-name'
const HEADER_CONTENT_ROOT = 'x-cr-content-root'
const HEADER_MEDIA_BASE = 'x-cr-media-base'
// Media facet identity — injected by the proxy only for media-eligible
// requests (plan + cdn_enabled + media stack checked proxy-side). All
// four must be present or the facet is not built and the media tools
// stay hidden from tools/list.
const HEADER_PROJECT_ID = 'x-cr-project-id'
const HEADER_WORKSPACE_ID = 'x-cr-workspace-id'
const HEADER_MEDIA_OWNER = 'x-cr-media-owner'
const HEADER_PLAN = 'x-cr-plan'

function headerString(value: string | string[] | undefined): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

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
    // Bind every session to the tenant identity the proxy injected when it
    // was created — a follow-up request whose `x-cr-*` headers resolve to a
    // different project 404s instead of reusing someone else's provider.
    sessionFingerprint: req => mcpTenantFingerprint(req.headers),
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

      // Public media delivery base (proxy-injected). The MCP content-write path
      // reads `provider.mediaBaseUrl` to normalize `media/...` references to the
      // same absolute URLs Studio's own write path produces.
      const mediaBase = headers[HEADER_MEDIA_BASE]

      // Media facet — built only when the proxy attested eligibility by
      // injecting ALL four identity headers (client values are stripped
      // proxy-side, so these are trusted). Absent set → no facet → the 5
      // media tools stay out of this session's tools/list.
      const projectId = headerString(headers[HEADER_PROJECT_ID])
      const workspaceId = headerString(headers[HEADER_WORKSPACE_ID])
      const mediaOwner = headerString(headers[HEADER_MEDIA_OWNER])
      const plan = headerString(headers[HEADER_PLAN])
      const media = (projectId && workspaceId && mediaOwner && plan)
        ? buildMcpMediaFacet({ projectId, workspaceId, uploadedBy: mediaOwner, plan: plan as Plan }) ?? undefined
        : undefined

      return createStudioGitProvider({
        installationId,
        owner,
        repo,
        contentRoot: typeof contentRoot === 'string' && contentRoot.length > 0
          ? contentRoot
          : undefined,
        mediaBaseUrl: typeof mediaBase === 'string' && mediaBase.length > 0
          ? mediaBase
          : undefined,
        media,
      })
    },
  })

  setInternalMcp(handle.url, () => handle.close())
}

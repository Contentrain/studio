/**
 * RFC 8414 authorization-server metadata. MCP clients (Claude, ChatGPT,
 * Codex) discover /oauth/authorize + /oauth/token + /oauth/register here
 * after reading the protected-resource metadata.
 *
 * Root-level route (server/routes/): outside the /api session middleware by
 * construction. 404s on the Supabase pair — the OAuth AS is managed-only.
 */
import { authorizationServerMetadata } from '~~/server/utils/oauth-server/metadata'
import { useMediaProvider } from '~~/server/utils/providers'

export default defineEventHandler((event) => {
  if (useRuntimeConfig().authProvider !== 'managed') {
    throw createError({ statusCode: 404, message: 'Not found' })
  }

  // Claude caches discovery globally for ~5 min; match that horizon.
  setResponseHeader(event, 'Cache-Control', 'public, max-age=300')
  return authorizationServerMetadata(undefined, { mediaAvailable: useMediaProvider() !== null })
})

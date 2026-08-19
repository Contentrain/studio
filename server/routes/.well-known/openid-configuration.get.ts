/**
 * OpenID Connect Discovery alias. Some MCP clients probe
 * /.well-known/openid-configuration before (or instead of)
 * /.well-known/oauth-authorization-server — serve the same document. We are
 * not an OIDC provider (no ID tokens, no openid scope); the shared fields
 * are all a public-client authorization-code flow needs.
 */
import { authorizationServerMetadata } from '~~/server/utils/oauth-server/metadata'
import { useMediaProvider } from '~~/server/utils/providers'

export default defineEventHandler((event) => {
  if (useRuntimeConfig().authProvider !== 'managed') {
    throw createError({ statusCode: 404, message: 'Not found' })
  }

  setResponseHeader(event, 'Cache-Control', 'public, max-age=300')
  return authorizationServerMetadata(undefined, { mediaAvailable: useMediaProvider() !== null })
})

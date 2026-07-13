/**
 * RFC 9728 protected-resource metadata, path-insertion variant — clients
 * derive `/.well-known/oauth-protected-resource/<mcp-path>` from the MCP
 * URL the user entered and try it first. The `resource` field must match
 * that URL byte-for-byte (no trailing slash), and Claude only ever uses the
 * FIRST `authorization_servers` entry.
 */
import { protectedResourceMetadata } from '~~/server/utils/oauth-server/metadata'
import { useMediaProvider } from '~~/server/utils/providers'

export default defineEventHandler((event) => {
  if (useRuntimeConfig().authProvider !== 'managed') {
    throw createError({ statusCode: 404, message: 'Not found' })
  }

  setResponseHeader(event, 'Cache-Control', 'public, max-age=300')
  return protectedResourceMetadata(undefined, { mediaAvailable: useMediaProvider() !== null })
})

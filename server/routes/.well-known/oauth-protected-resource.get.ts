/**
 * RFC 9728 protected-resource metadata, root variant — the fallback probe
 * clients try when the path-inserted document 404s. Same document; the
 * `resource` field still names the canonical MCP endpoint.
 */
import { protectedResourceMetadata } from '~~/server/utils/oauth-server/metadata'

export default defineEventHandler((event) => {
  if (useRuntimeConfig().authProvider !== 'managed') {
    throw createError({ statusCode: 404, message: 'Not found' })
  }

  setResponseHeader(event, 'Cache-Control', 'public, max-age=300')
  return protectedResourceMetadata()
})

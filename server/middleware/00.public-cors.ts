/**
 * CORS for the public embed surfaces (forms, comments).
 *
 * Both are called from someone else's site with `Content-Type:
 * application/json`, so the browser sends an OPTIONS preflight first. Nitro
 * routes are method-suffixed (`*.post.ts`) and never see OPTIONS, so the
 * preflight has to be answered here — before the auth middleware, which
 * would otherwise 401 it. Non-preflight requests just get the headers and
 * continue to their route.
 */

const PUBLIC_CORS_PREFIXES = ['/api/forms/', '/api/comments/']

export default defineEventHandler((event) => {
  const path = getRequestPath(event)
  if (!PUBLIC_CORS_PREFIXES.some(prefix => path.startsWith(prefix))) return

  setResponseHeader(event, 'Access-Control-Allow-Origin', '*')
  setResponseHeader(event, 'Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  setResponseHeader(event, 'Access-Control-Allow-Headers', 'Content-Type')
  setResponseHeader(event, 'Access-Control-Max-Age', 86400)

  if (event.method === 'OPTIONS') {
    setResponseStatus(event, 204)
    return ''
  }
})

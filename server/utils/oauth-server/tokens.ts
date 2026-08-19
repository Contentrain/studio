/**
 * Access-token verification seam for the remote MCP resource route.
 *
 * Opaque-token implementation: parse the Bearer header, resolve the SHA-256
 * hash to its grant (expiry + revocation checked in the store). If the
 * token format ever changes (e.g. JWTs), only this module and the token
 * endpoint's issuance swap — the resource route keeps calling
 * `verifyMcpAccessToken`.
 */
import type { GrantContext } from './store'
import { getGrantContextByAccessToken } from './store'

const ACCESS_TOKEN_PREFIX = 'crn_oat_'

export async function verifyMcpAccessToken(authHeader: string | undefined): Promise<GrantContext | null> {
  if (!authHeader?.startsWith('Bearer ')) return null

  const token = authHeader.slice('Bearer '.length).trim()
  if (!token.startsWith(ACCESS_TOKEN_PREFIX)) return null

  return getGrantContextByAccessToken(token)
}

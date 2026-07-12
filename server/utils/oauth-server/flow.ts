/**
 * Pending-authorization flow cookie — the validated /oauth/authorize request
 * sealed across the consent bounce (and a possible login round-trip), same
 * mechanism as the login dance's `contentrain-oauth-flow` cookie.
 */
import type { H3Event } from 'h3'

export interface OAuthAuthzFlowData {
  clientId: string
  clientKind: 'cimd' | 'dcr'
  /** What the consent screen must display as the relying party (CIMD: client_id URL host). */
  clientDisplayHost: string
  clientName: string | null
  logoUri: string | null
  redirectUri: string
  scope: string
  state: string | null
  codeChallenge: string
  resource: string | null
  /** Spec SHOULD: warn when every registered redirect is loopback (impersonation risk). */
  loopbackOnly: boolean
  createdAt: number
}

const AUTHZ_FLOW_COOKIE = 'contentrain-oauth-authz'
const AUTHZ_FLOW_MAX_AGE = 60 * 10

export async function authzFlowSession(event: H3Event) {
  return useSession<OAuthAuthzFlowData>(event, {
    password: useRuntimeConfig().sessionSecret as string,
    name: AUTHZ_FLOW_COOKIE,
    maxAge: AUTHZ_FLOW_MAX_AGE,
  })
}

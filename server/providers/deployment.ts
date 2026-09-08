/**
 * Deployment provider interface (core, AGPL).
 *
 * Triggers a rebuild/redeploy of the site that consumes a project's content.
 * The core implementation posts a host build hook (`server/utils/deploy-hooks.ts`);
 * vendor-specific implementations (deploy status, previews, custom domains)
 * may live in `ee/` behind this same interface.
 *
 * `DeployTarget` carries the resolved (decrypted) hook only for the duration
 * of a trigger — what is stored on the project is encrypted and hinted.
 */

export type DeployTargetProvider = 'netlify' | 'vercel' | 'cloudflare-pages' | 'generic'

export type DeployReason = 'content_published' | 'schedule' | 'manual'

export interface DeployTarget {
  provider: DeployTargetProvider
  hookUrl: string
}

export interface DeployResult {
  ok: boolean
  /** HTTP status of the hook call; 0 when the request never completed. */
  status: number
  error?: string
}

export interface DeploymentProvider {
  key: string
  triggerDeploy: (target: DeployTarget, reason: DeployReason) => Promise<DeployResult>
}

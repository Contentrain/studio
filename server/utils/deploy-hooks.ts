/**
 * Deploy hooks (S-02) — the core, host-neutral deployment provider.
 *
 * Every static host worth targeting exposes a build hook: an HTTPS URL that
 * rebuilds and redeploys the site when POSTed (Netlify "build hooks", Vercel
 * "deploy hooks", Cloudflare Pages "deploy hooks", or any custom endpoint).
 * That is the whole contract Studio needs, so it lives in core with no
 * vendor SDK; vendor-specific extras (deploy status, previews) can layer on
 * in `ee/` behind the same `DeploymentProvider` interface.
 *
 * The hook URL is a credential: stored AES-GCM encrypted inside
 * `projects.deploy_target`, only a hint is ever returned to the UI.
 *
 * Triggers: after content lands on `contentrain` (`content_published`),
 * when a scheduled publish/expire boundary passes (`schedule`), and by hand.
 * Per-project debounce keeps a burst of merges from queueing a dozen builds.
 */

import type { DeployReason, DeployResult, DeploymentProvider, DeployTarget, DeployTargetProvider } from '~~/server/providers/deployment'
import { decryptApiKey, encryptApiKey } from './encryption'
import { isAllowedWebhookUrl } from './webhook-engine'

export const DEPLOY_PROVIDERS: readonly DeployTargetProvider[] = ['netlify', 'vercel', 'cloudflare-pages', 'generic']
const DEBOUNCE_MS = 60_000
const HOOK_TIMEOUT_MS = 15_000

/** What is stored on `projects.deploy_target`. */
export interface StoredDeployTarget {
  provider: DeployTargetProvider
  hook_url_encrypted: string
  hook_hint: string
  triggers: { on_publish: boolean, on_schedule: boolean }
  updated_at: string
  last_triggered_at?: string | null
  last_status?: number | null
}

/** What the UI sees — never the URL. */
export interface PublicDeployTarget {
  provider: DeployTargetProvider
  hookHint: string
  triggers: { on_publish: boolean, on_schedule: boolean }
  updatedAt: string
  lastTriggeredAt: string | null
  lastStatus: number | null
}

function secret(): string {
  const config = useRuntimeConfig()
  return String(config.sessionSecret ?? '')
}

export function hookHint(url: string): string {
  try {
    const u = new URL(url)
    const tail = u.pathname.replace(/\/+$/, '').split('/').pop() ?? ''
    return `${u.host}/…${tail.slice(-4)}`
  }
  catch {
    return '…'
  }
}

export function isDeployProvider(value: unknown): value is DeployTargetProvider {
  return typeof value === 'string' && (DEPLOY_PROVIDERS as readonly string[]).includes(value)
}

/** Validate + encrypt a hook URL into the stored shape. */
export function encodeDeployTarget(input: { provider: DeployTargetProvider, hookUrl: string, triggers?: Partial<StoredDeployTarget['triggers']> }, previous?: StoredDeployTarget | null): StoredDeployTarget {
  const url = input.hookUrl.trim()
  let parsed: URL
  try {
    parsed = new URL(url)
  }
  catch {
    throw createError({ statusCode: 400, message: errorMessage('deploy.hook_url_invalid') })
  }
  if (parsed.protocol !== 'https:' || !isAllowedWebhookUrl(url))
    throw createError({ statusCode: 400, message: errorMessage('deploy.hook_url_invalid') })

  return {
    provider: input.provider,
    hook_url_encrypted: encryptApiKey(url, secret()),
    hook_hint: hookHint(url),
    triggers: {
      on_publish: input.triggers?.on_publish ?? previous?.triggers.on_publish ?? true,
      on_schedule: input.triggers?.on_schedule ?? previous?.triggers.on_schedule ?? true,
    },
    updated_at: new Date().toISOString(),
    last_triggered_at: previous?.last_triggered_at ?? null,
    last_status: previous?.last_status ?? null,
  }
}

export function toPublicDeployTarget(target: StoredDeployTarget): PublicDeployTarget {
  return {
    provider: target.provider,
    hookHint: target.hook_hint,
    triggers: target.triggers,
    updatedAt: target.updated_at,
    lastTriggeredAt: target.last_triggered_at ?? null,
    lastStatus: target.last_status ?? null,
  }
}

export function readStoredDeployTarget(value: unknown): StoredDeployTarget | null {
  if (!value || typeof value !== 'object') return null
  const t = value as Partial<StoredDeployTarget>
  if (!isDeployProvider(t.provider) || typeof t.hook_url_encrypted !== 'string') return null
  return {
    provider: t.provider,
    hook_url_encrypted: t.hook_url_encrypted,
    hook_hint: typeof t.hook_hint === 'string' ? t.hook_hint : '…',
    triggers: {
      on_publish: t.triggers?.on_publish !== false,
      on_schedule: t.triggers?.on_schedule !== false,
    },
    updated_at: typeof t.updated_at === 'string' ? t.updated_at : new Date(0).toISOString(),
    last_triggered_at: typeof t.last_triggered_at === 'string' ? t.last_triggered_at : null,
    last_status: typeof t.last_status === 'number' ? t.last_status : null,
  }
}

function resolveTarget(stored: StoredDeployTarget): DeployTarget {
  const config = useRuntimeConfig()
  const previous = String(config.sessionSecretPrevious ?? '') || undefined
  return { provider: stored.provider, hookUrl: decryptApiKey(stored.hook_url_encrypted, secret(), previous) }
}

// ─── The core provider: POST the hook ───

export const buildHookDeploymentProvider: DeploymentProvider = {
  key: 'build_hook',
  async triggerDeploy(target, reason) {
    try {
      const response = await fetch(target.hookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': 'Contentrain-Studio/1.0' },
        body: JSON.stringify({ source: 'contentrain-studio', reason, at: new Date().toISOString() }),
        signal: AbortSignal.timeout(HOOK_TIMEOUT_MS),
      })
      return { ok: response.ok, status: response.status }
    }
    catch (error) {
      return { ok: false, status: 0, error: error instanceof Error ? error.message : 'request failed' }
    }
  },
}

// ─── Trigger orchestration ───

const lastTrigger = new Map<string, number>()
const pendingTrigger = new Map<string, ReturnType<typeof setTimeout>>()

export interface TriggerDeployInput {
  projectId: string
  workspaceId?: string
  reason: DeployReason
  /** Bypass the debounce (manual "Deploy now"). */
  immediate?: boolean
  provider?: DeploymentProvider
}

/**
 * Fire the project's deploy hook for `reason`, honouring the target's trigger
 * switches. Debounced per project for automatic reasons: a burst of merges
 * within a minute produces one build, sent after the burst settles.
 */
export async function triggerProjectDeploy(input: TriggerDeployInput): Promise<DeployResult | null> {
  const db = useDatabaseProvider()
  const project = await db.getProjectById(input.projectId, 'id, workspace_id, deploy_target')
  const stored = readStoredDeployTarget(project?.deploy_target)
  if (!project || !stored) return null

  if (input.reason === 'content_published' && !stored.triggers.on_publish) return null
  if (input.reason === 'schedule' && !stored.triggers.on_schedule) return null

  const workspaceId = input.workspaceId ?? String(project.workspace_id)
  const run = async (): Promise<DeployResult> => {
    const provider = input.provider ?? buildHookDeploymentProvider
    const result = await provider.triggerDeploy(resolveTarget(stored), input.reason)
    lastTrigger.set(input.projectId, Date.now())
    await db.setProjectDeployTarget(input.projectId, {
      ...stored,
      last_triggered_at: new Date().toISOString(),
      last_status: result.status,
    } as unknown as Record<string, unknown>).catch(() => {})
    emitWebhookEvent(input.projectId, workspaceId, 'deploy.triggered', {
      provider: stored.provider,
      reason: input.reason,
      ok: result.ok,
      status: result.status,
    }).catch(() => {})
    return result
  }

  if (input.immediate) return run()

  const since = Date.now() - (lastTrigger.get(input.projectId) ?? 0)
  if (since >= DEBOUNCE_MS && !pendingTrigger.has(input.projectId)) return run()

  // Coalesce into one trailing trigger.
  if (!pendingTrigger.has(input.projectId)) {
    const wait = Math.max(0, DEBOUNCE_MS - since)
    pendingTrigger.set(input.projectId, setTimeout(() => {
      pendingTrigger.delete(input.projectId)
      run().catch(() => {})
    }, wait))
  }
  return null
}

/** Test seam. */
export function _resetDeployDebounce(): void {
  for (const t of pendingTrigger.values()) clearTimeout(t)
  pendingTrigger.clear()
  lastTrigger.clear()
}

import type { H3Event } from 'h3'
import type { CDNProvider } from '../providers/cdn'
import type { DatabaseProvider } from '../providers/database'
import type { MediaProvider } from '../providers/media'

export type EnterpriseRouteHandler<T = unknown> = (event: H3Event) => Promise<T> | T
export type EnterprisePlan = string | null | undefined
export type EnterpriseRouteName
  = | 'listWorkspaceAiKeys'
    | 'createWorkspaceAiKey'
    | 'deleteWorkspaceAiKey'
    | 'listProjectWebhooks'
    | 'createProjectWebhook'
    | 'updateProjectWebhook'
    | 'deleteProjectWebhook'
    | 'testProjectWebhook'
    | 'listWebhookDeliveries'
    | 'listProjectConversationKeys'
    | 'createProjectConversationKey'
    | 'updateProjectConversationKey'
    | 'deleteProjectConversationKey'
    | 'handleConversationApiMessage'
    | 'handleConversationApiHistory'

export interface EnterpriseProjectMemberAccess {
  role: 'editor' | 'reviewer' | 'viewer'
  specificModels: boolean
  allowedModels: string[]
}

export interface EnterpriseBridge {
  listWorkspaceAiKeys: EnterpriseRouteHandler
  createWorkspaceAiKey: EnterpriseRouteHandler
  deleteWorkspaceAiKey: EnterpriseRouteHandler

  listProjectWebhooks: EnterpriseRouteHandler
  createProjectWebhook: EnterpriseRouteHandler
  updateProjectWebhook: EnterpriseRouteHandler
  deleteProjectWebhook: EnterpriseRouteHandler
  testProjectWebhook: EnterpriseRouteHandler
  listWebhookDeliveries: EnterpriseRouteHandler

  listProjectConversationKeys: EnterpriseRouteHandler
  createProjectConversationKey: EnterpriseRouteHandler
  updateProjectConversationKey: EnterpriseRouteHandler
  deleteProjectConversationKey: EnterpriseRouteHandler

  handleConversationApiMessage: EnterpriseRouteHandler
  handleConversationApiHistory: EnterpriseRouteHandler

  createCDNProvider?: (config: {
    accountId: string
    accessKeyId: string
    secretAccessKey: string
    bucket: string
  }) => CDNProvider
  createMediaProvider?: (config: { cdn: CDNProvider, db: DatabaseProvider }) => MediaProvider
  trackCDNUsage?: (projectId: string, apiKeyId: string, responseSizeBytes: number) => Promise<void>
  emitWebhookEvent?: (projectId: string, workspaceId: string, event: string, data: Record<string, unknown>) => Promise<void>
  processWebhookRetries?: () => Promise<number>
  normalizeProjectMemberAccess?: (input: {
    plan: EnterprisePlan
    role: 'editor' | 'reviewer' | 'viewer' | null | undefined
    specificModels?: boolean | null
    allowedModels?: string[] | null
  }) => EnterpriseProjectMemberAccess
  resolveChatApiKey?: (input: {
    workspaceId: string
    userId: string
    accessToken: string
    plan: EnterprisePlan
    sessionSecret: string
    studioApiKey?: string | null
  }) => Promise<{ apiKey: string, usageSource: 'byoa' | 'studio' } | null>
}

const ENTERPRISE_BRIDGE_KEY = Symbol.for('contentrain.enterprise.bridge')
const ENTERPRISE_BRIDGE_PROMISE_KEY = Symbol.for('contentrain.enterprise.bridge.promise')

type EnterpriseGlobalState = typeof globalThis & {
  [ENTERPRISE_BRIDGE_KEY]?: EnterpriseBridge | null
  [ENTERPRISE_BRIDGE_PROMISE_KEY]?: Promise<EnterpriseBridge | null> | null
}

function enterpriseGlobals(): EnterpriseGlobalState {
  return globalThis as EnterpriseGlobalState
}

/**
 * Tests can inject a fake enterprise bridge without touching the ee/ tree.
 */
export function setEnterpriseBridgeForTesting(bridge: EnterpriseBridge | null | undefined) {
  const state = enterpriseGlobals()
  state[ENTERPRISE_BRIDGE_KEY] = bridge
  state[ENTERPRISE_BRIDGE_PROMISE_KEY] = null
}

export async function initEnterpriseBridge(): Promise<void> {
  await loadEnterpriseBridge()
}

export function getLoadedEnterpriseBridge(): EnterpriseBridge | null {
  return enterpriseGlobals()[ENTERPRISE_BRIDGE_KEY] ?? null
}

export async function runEnterpriseRoute<T>(
  handlerName: EnterpriseRouteName,
  featureMessageKey: string,
  event: H3Event,
  featureKey?: string,
): Promise<T> {
  // Plan + edition gate — when a featureKey is supplied and the
  // billing middleware has already resolved `event.context.billing`,
  // reject the request before touching the bridge if the caller's
  // plan doesn't grant the feature. This keeps Starter customers on
  // Managed out of Pro+ endpoints even when the bridge itself is
  // plan-agnostic.
  //
  // When `event.context.billing` is absent (unit-level integration
  // tests that bypass middleware, or a misconfigured deploy missing
  // the billing middleware) the plan gate is skipped and enforcement
  // falls through to the bridge-availability check below. Production
  // workspace-scoped routes always run through `03.billing.ts`, so
  // the gate is effectively always active in real traffic.
  if (featureKey) {
    const billingContext = (event.context as { billing?: { effectivePlan?: string } } | undefined)?.billing
    const plan = billingContext?.effectivePlan
    if (plan) {
      const { hasFeature } = await import('./license')
      if (!hasFeature(plan, featureKey)) {
        throw createError({
          statusCode: 403,
          message: errorMessage(featureMessageKey),
        })
      }
    }
  }

  const bridge = await loadEnterpriseBridge()

  if (!bridge || typeof bridge[handlerName] !== 'function') {
    throw createError({
      statusCode: 403,
      message: errorMessage(featureMessageKey),
    })
  }

  return await bridge[handlerName](event) as T
}

export async function trackEnterpriseCdnUsage(
  projectId: string,
  apiKeyId: string,
  responseSizeBytes: number,
): Promise<void> {
  const bridge = await loadEnterpriseBridge()
  await bridge?.trackCDNUsage?.(projectId, apiKeyId, responseSizeBytes)
}

export async function emitEnterpriseWebhookEvent(
  projectId: string,
  workspaceId: string,
  event: string,
  data: Record<string, unknown>,
): Promise<void> {
  const bridge = await loadEnterpriseBridge()
  await bridge?.emitWebhookEvent?.(projectId, workspaceId, event, data)
}

export async function processEnterpriseWebhookRetries(): Promise<number> {
  const bridge = await loadEnterpriseBridge()
  if (!bridge?.processWebhookRetries)
    return 0

  return bridge.processWebhookRetries()
}

export async function resolveEnterpriseChatApiKey(input: {
  workspaceId: string
  userId: string
  accessToken: string
  plan: EnterprisePlan
  sessionSecret: string
  previousSessionSecret?: string
  studioApiKey?: string | null
}): Promise<{ apiKey: string, usageSource: 'byoa' | 'studio' } | null> {
  const bridge = await loadEnterpriseBridge()
  if (!bridge?.resolveChatApiKey)
    return null

  return bridge.resolveChatApiKey(input)
}

export async function normalizeEnterpriseProjectMemberAccess(input: {
  plan: EnterprisePlan
  role: 'editor' | 'reviewer' | 'viewer' | null | undefined
  specificModels?: boolean | null
  allowedModels?: string[] | null
}): Promise<EnterpriseProjectMemberAccess> {
  const bridge = await loadEnterpriseBridge()
  if (!bridge?.normalizeProjectMemberAccess) {
    return {
      role: 'editor',
      specificModels: false,
      allowedModels: [],
    }
  }

  return bridge.normalizeProjectMemberAccess(input)
}

async function loadEnterpriseBridge(): Promise<EnterpriseBridge | null> {
  const state = enterpriseGlobals()

  if (state[ENTERPRISE_BRIDGE_KEY] !== undefined)
    return state[ENTERPRISE_BRIDGE_KEY] ?? null

  if (!state[ENTERPRISE_BRIDGE_PROMISE_KEY]) {
    state[ENTERPRISE_BRIDGE_PROMISE_KEY] = import('../../ee/enterprise')
      .then((mod) => {
        if (typeof mod.createEnterpriseBridge !== 'function') return null
        return mod.createEnterpriseBridge()
      })
      .catch(() => null)
  }

  state[ENTERPRISE_BRIDGE_KEY] = await state[ENTERPRISE_BRIDGE_PROMISE_KEY]
  return state[ENTERPRISE_BRIDGE_KEY] ?? null
}

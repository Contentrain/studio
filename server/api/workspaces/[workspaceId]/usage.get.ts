/**
 * GET /api/workspaces/:workspaceId/usage
 *
 * Usage against the plan for the current period, per meter
 * (`server/utils/workspace-usage.ts`).
 *
 * Owners and admins get the full picture: overage switches, prices and
 * amounts. Members get the meters only (`canManage: false`) — they cannot
 * change the plan or the switches, but a member whose AI stopped needs to see
 * why and when it comes back. The route used to answer them 403, and the
 * panel rendered nothing at all.
 */

import { normalizePlan } from '../../../../shared/utils/license'
import { resolveUsagePeriod } from '../../../../server/utils/usage-period'
import { resolveOverageLocks } from '../../../../server/utils/overage-lock'
import type { OverageLock, OverageLockAccount } from '../../../../server/utils/overage-lock'
import { computeWorkspaceUsage } from '../../../../server/utils/workspace-usage'

const WORKSPACE_FIELDS = 'id, plan, overage_settings, media_storage_bytes'

export default defineEventHandler(async (event) => {
  const session = requireAuth(event)
  const db = useDatabaseProvider()
  const workspaceId = getRouterParam(event, 'workspaceId')

  if (!workspaceId)
    throw createError({ statusCode: 400, message: errorMessage('validation.workspace_id_required') })

  const managed = await db.getWorkspaceForUser(session.accessToken, session.user.id, workspaceId, ['owner', 'admin'], WORKSPACE_FIELDS)
  const workspace = managed
    ?? await db.getWorkspaceForUser(session.accessToken, session.user.id, workspaceId, ['member'], WORKSPACE_FIELDS)

  if (!workspace)
    throw createError({ statusCode: 403, message: errorMessage('auth.forbidden') })
  const canManage = !!managed

  // The same plan the limits are actually enforced against. Reading
  // `workspaces.plan` directly would show a locked workspace (expired
  // trial, expired grace) the limits of the plan it no longer has —
  // every gate resolves through `effectivePlan`, so this screen must too.
  const plan = event.context?.billing?.effectivePlan ?? normalizePlan(workspace.plan as string | null)
  const overageSettings = (workspace.overage_settings as Record<string, boolean>) ?? {}

  // Toggles the subscription cannot bill (trial, or a meter it has no price
  // for) show as locked, with why and until when — never as on.
  let overageLocks: Record<string, OverageLock> = {}
  try {
    overageLocks = resolveOverageLocks(await db.getActivePaymentAccount(workspaceId) as OverageLockAccount | null)
  }
  catch {
    // Billing metadata unreadable: show the toggles as stored.
  }

  // The three credit pools are counted in the workspace's billing period.
  const period = await resolveUsagePeriod(workspaceId)
  const usage = await computeWorkspaceUsage(db, {
    workspaceId,
    plan,
    overageSettings,
    storageBytes: (workspace.media_storage_bytes as number) ?? 0,
    period,
    overageLocks,
  })

  // CLI-compatible flat format: ?format=simple
  const query = getQuery(event) as { format?: string }
  if (query.format === 'simple') {
    const keyMap: Record<string, string> = {
      ai_messages: 'aiMessages',
      form_submissions: 'formSubmissions',
      comments: 'comments',
      cdn_bandwidth: 'cdnBandwidthGb',
      media_storage: 'mediaStorageGb',
      api_messages: 'apiMessages',
      mcp_calls: 'mcpCalls',
    }
    const simple: Record<string, { current: number, limit: number, percentage: number }> = {}
    for (const c of usage.categories) {
      const key = keyMap[c.key] ?? c.key
      simple[key] = { current: c.current, limit: c.limit, percentage: c.percentage }
    }
    return simple
  }

  // Members see the meters, not the money or the switches they cannot use.
  const categories = canManage
    ? usage.categories
    : usage.categories.map(c => ({ ...c, overageLock: null, overageUnitPrice: 0, overageAmount: 0 }))

  return {
    // Kept as the period key for compatibility with existing clients.
    billingPeriod: period.key,
    // The billing window. Each category carries its own `resetsAt`: forms,
    // comments and CDN still reset on the 1st.
    period: {
      startsAt: period.startsAt,
      resetsAt: period.resetsAt,
      source: period.source,
    },
    canManage,
    categories,
    byoaRequests: usage.byoaRequests,
    totalOverageAmount: canManage ? usage.totalOverageAmount : 0,
    projectedOverageAmount: canManage ? usage.projectedOverageAmount : 0,
  }
})

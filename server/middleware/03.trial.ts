/**
 * Trial expiry middleware.
 *
 * Checks workspace trial_ends_at on workspace-scoped API routes.
 * If trial has expired and no active subscription, returns 402.
 * Attaches trial state to event.context.trial for downstream use.
 */

const WORKSPACE_ROUTE_PREFIX = '/api/workspaces/'

// Routes that should work even with expired trial
const TRIAL_EXEMPT_SUFFIXES = [
  '/select-plan',
  '/billing/',
]

export default defineEventHandler(async (event) => {
  const path = getRequestPath(event)

  // Only check workspace-scoped API routes
  if (!path.startsWith(WORKSPACE_ROUTE_PREFIX))
    return

  // Extract workspaceId from path: /api/workspaces/:workspaceId/...
  const segments = path.slice(WORKSPACE_ROUTE_PREFIX.length).split('/')
  const workspaceId = segments[0]
  if (!workspaceId || segments.length < 2)
    return

  // Allow trial-exempt routes (plan selection, billing)
  if (TRIAL_EXEMPT_SUFFIXES.some(s => path.includes(s)))
    return

  // Auth must be resolved first (by 01.auth middleware)
  if (!event.context.auth)
    return

  const db = useDatabaseProvider()
  const workspace = await db.getWorkspaceById(
    workspaceId,
    'plan, trial_ends_at',
  )

  if (!workspace)
    return

  const trialEndsAt = (workspace as { trial_ends_at?: string }).trial_ends_at
  if (!trialEndsAt) {
    // No trial — active subscription or never had trial
    event.context.trial = { active: false, expired: false }
    return
  }

  const now = new Date()
  const trialEnd = new Date(trialEndsAt)

  if (trialEnd > now) {
    // Trial is still active
    const daysLeft = Math.ceil((trialEnd.getTime() - now.getTime()) / (1000 * 60 * 60 * 24))
    event.context.trial = { active: true, expired: false, endsAt: trialEndsAt, daysLeft }
    return
  }

  // Trial has expired — check if they have a paid plan set
  const plan = (workspace as { plan?: string }).plan
  if (plan && plan !== 'starter') {
    // They selected a plan but trial expired — need payment
    // For now allow access (Stripe enforcement comes in Part 4)
    event.context.trial = { active: false, expired: true, plan }
    return
  }

  // Trial expired, no paid plan — block access
  throw createError({
    statusCode: 402,
    message: 'Your trial has expired. Please choose a plan to continue.',
    data: { trialExpired: true, workspaceId },
  })
})

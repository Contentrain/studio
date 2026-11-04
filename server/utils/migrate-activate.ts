/**
 * Start the prepaid Studio year of a bundle Migrate collected (`POST /api/migrate/grants/activate`).
 *
 * A provision with `billing.collector: 'migrate'` reserved the grant on a workspace and opened no
 * checkout (`migrate-provision.ts`). Migrate's own checkout took the whole bundle; once it is paid,
 * Migrate reports the payment here and Studio starts the year: from `paid_at`, for
 * `MIGRATE_PREPAID_YEAR_SECONDS`, on the reserved workspace (migration 055). No subscription is
 * opened and nothing renews by itself; the billing state reads the year from the workspace
 * (`prepaid`, `server/utils/billing.ts`).
 *
 * - Idempotent per transaction: the same `transaction_id` again answers the same year (the stored
 *   one), and finishes a first call that stopped half way.
 * - A different transaction for a grant already paid is refused (409 `already_active`): the money
 *   is Migrate's to give back, the year is not started twice.
 * - The order's own payment after a revoke (the refund came first) answers `revoked`: nothing starts.
 *   Another transaction on a revoked grant is refused (409 `grant_revoked`).
 * - The reserved workspace is checked again: the payment page stays payable, so the customer may have
 *   started a subscription on it since (409 `subscription_exists`).
 * - The Studio part of the payment must be the year Studio reserved (409 `amount_mismatch`).
 *
 * Every refusal carries `data.code`, the stable handle Migrate matches on; the order then waits for an
 * operator. The grant is written first, then the workspace, then the grant is marked redeemed, so a
 * retry after a failure finds the grant and writes the rest.
 */
import type { MigrateGrantActivateRequest, MigrateGrantActivateResponse, MigrateStudioPlan } from '@contentrain/types'
import { MIGRATE_PREPAID_YEAR_SECONDS, validateMigrateGrantActivateResponse } from '@contentrain/types'
import { bundleYear1Cents } from '../../shared/utils/migrate-bundle'
import { isPrepaidLive } from './billing'

function refuse(key: string, code: string): never {
  throw createError({ statusCode: 409, message: errorMessage(key), data: { code } })
}

const seconds = (value: unknown): number => Math.floor(new Date(value as string).getTime() / 1000)

export async function activateMigrateGrant(request: MigrateGrantActivateRequest): Promise<MigrateGrantActivateResponse> {
  const db = useDatabaseProvider()
  const { payment } = request
  // A provider transaction id is a plain token (Paddle: `txn_…`); it is matched in a database filter.
  if (!/^[\w-]{1,128}$/.test(payment.transaction_id)) throw createError({ statusCode: 400, message: errorMessage('migrate.s2s_invalid') })
  const grant = await db.getMigrateGrantByOrderId(request.order_id)
  if (!grant) throw createError({ statusCode: 404, message: errorMessage('migrate.grant_not_found') })
  if (grant.kind !== 'bundle' || grant.collector !== 'migrate') refuse('migrate.claim_taken', 'not_migrate_collected')

  const paymentRef = grant.payment_ref as string | null
  if (grant.revoked_at) {
    if (paymentRef && paymentRef !== payment.transaction_id) refuse('migrate.grant_revoked', 'grant_revoked')
    return answer({ state: 'revoked' }, payment.paid_at)
  }
  if (paymentRef && paymentRef !== payment.transaction_id) refuse('migrate.grant_used', 'already_active')
  // Redeemed with no payment: an order a running plan covered. It holds no Studio year to start.
  if (grant.redeemed_at && !paymentRef) refuse('migrate.grant_used', 'covered')

  const workspaceId = grant.workspace_id as string | null
  if (!workspaceId) refuse('migrate.quote_changed', 'not_reserved')
  const workspace = await db.getWorkspaceById(workspaceId, 'id, slug, prepaid_until')
  if (!workspace) throw createError({ statusCode: 500, message: errorMessage('generic.server_error') })
  const plan = grant.plan as MigrateStudioPlan

  // Already started by this transaction: answer the stored year.
  if (grant.redeemed_at && paymentRef === payment.transaction_id)
    return answer(redeemed(plan, String(workspace.slug), grant.prepaid_starts_at, grant.prepaid_ends_at), payment.paid_at)

  if (payment.studio_amount_cents !== bundleYear1Cents(plan)) refuse('migrate.quote_changed', 'amount_mismatch')

  // A first call that stopped after writing the grant has started the year on this workspace already.
  const startedHere = paymentRef === payment.transaction_id && grant.prepaid_ends_at != null
    && seconds(workspace.prepaid_until) === seconds(grant.prepaid_ends_at)
  if (!startedHere) {
    if (isPrepaidLive(workspace.prepaid_until)) refuse('billing.subscription_exists', 'subscription_exists')
    const account = await db.getActivePaymentAccount(workspaceId)
    const status = account?.subscription_status as string | null | undefined
    if (account?.subscription_id && status && !['canceled', 'incomplete_expired'].includes(status))
      refuse('billing.subscription_exists', 'subscription_exists')
  }

  const startsAt = grant.prepaid_starts_at ? new Date(grant.prepaid_starts_at as string) : new Date(payment.paid_at * 1000)
  const endsAt = grant.prepaid_ends_at ? new Date(grant.prepaid_ends_at as string) : new Date((payment.paid_at + MIGRATE_PREPAID_YEAR_SECONDS) * 1000)
  const recorded = await db.recordMigrateGrantPrepaid(String(grant.id), {
    paymentRef: payment.transaction_id,
    startsAt: startsAt.toISOString(),
    endsAt: endsAt.toISOString(),
  })
  // Revoked or paid by another transaction in the meantime: the caller asks again and gets that answer.
  if (!recorded) refuse('migrate.grant_used', 'already_active')

  // `plan` too, for the readers of the raw column; billing reads `prepaid_plan`.
  await db.updateWorkspace('', workspaceId, { prepaid_until: endsAt.toISOString(), prepaid_plan: plan, plan })
  // A revoke that landed between the two writes found no year on the workspace yet: take it back off.
  const after = await db.getMigrateGrantById(String(grant.id))
  if (after?.revoked_at) {
    await db.updateWorkspace('', workspaceId, { prepaid_until: null, prepaid_plan: null })
    return answer({ state: 'revoked' }, payment.paid_at)
  }
  await db.markMigrateGrantRedeemed(String(grant.id), null)
  return answer(redeemed(plan, String(workspace.slug), startsAt, endsAt), payment.paid_at)
}

function redeemed(plan: MigrateStudioPlan, slug: string, startsAt: unknown, endsAt: unknown): MigrateGrantActivateResponse {
  return { state: 'redeemed', plan, workspace_slug: slug, starts_at: seconds(startsAt), ends_at: seconds(endsAt) }
}

/** Fail closed on our own answer: Migrate's refund counts the unused days from it. */
function answer(response: MigrateGrantActivateResponse, paidAt: number): MigrateGrantActivateResponse {
  const checked = validateMigrateGrantActivateResponse(response, { paid_at: paidAt })
  if (checked.ok) return response
  // eslint-disable-next-line no-console -- ops visibility: a refused own answer is otherwise silent
  console.error('[migrate-activate] own response failed validation:', { state: response.state, errors: checked.errors })
  throw createError({ statusCode: 500, message: errorMessage('migrate.s2s_invalid') })
}

/**
 * Provision a "Migrate with Studio" bundle (S2).
 *
 * Migrate has sold the customer one order: its own fee plus Studio year 1.
 * Before they pay, Migrate asks Studio — server to server, signed — to open
 * the Studio side: find or create the account behind the GitHub user, give it
 * a grant for the order, and open ONE Polar checkout whose first invoice is the
 * total Migrate quoted. Studio sets no price of its own on this path; it only
 * agrees or refuses:
 *
 * - the quote must be what Studio computes now (Migrate fee + the Studio line
 *   from the account's state), else `quote_changed` and Migrate re-quotes;
 * - `none` opens the checkout. `covers` (a running plan at least the sized one)
 *   opens none: the grant is tied to that plan's workspace and answers `redeemed`,
 *   the Studio fee is $0 and Polar is not called. `too_small` (an upgrade) is not
 *   built yet and is refused with a clear code instead of a checkout at the
 *   wrong amount;
 * - the return address must be on this Studio's Migrate allowlist.
 *
 * One grant per order. A repeated provision returns the checkout the grant
 * already opened while it is still payable and the amount is unchanged; it
 * never opens a second one that could be paid twice.
 */
import type { MigrateProvisionResponse, MigrateStudioClaimV2 } from '@contentrain/types'
import { validateMigrateProvisionResponse } from '@contentrain/types'
import { IdentityConflictError } from '../providers/auth'
import { coveringWorkspace, resolveMigrateAccountState } from './migrate-account-state'
import { migrateExportOrigins } from './migrate-comments-export'

/** A checkout is reused only while it has at least this long left to be paid. */
const MIN_REMAINING_MS = 5 * 60 * 1000

function fail(statusCode: number, key: string): never {
  throw createError({ statusCode, message: errorMessage(key) })
}

export function isAllowedReturnUrl(returnUrl: string, origins: string[]): boolean {
  try {
    return origins.includes(new URL(returnUrl).origin)
  }
  catch {
    return false
  }
}

/** A workspace that still carries a subscription (even one scheduled to end) cannot take a second one. */
const hasLiveSubscription = (account: Record<string, unknown> | null | undefined) => {
  const status = account?.subscription_status as string | null | undefined
  return Boolean(account?.subscription_id && status && !['canceled', 'incomplete_expired'].includes(status))
}

/**
 * The workspace the bundle's subscription belongs on: the account's personal one, else the first, skipping any that already
 * holds a subscription. When every owned workspace does, `blockedSlug` is the slug of the first of them (the personal one
 * first) — where the customer resumes or manages that plan.
 */
async function bundleWorkspace(userId: string): Promise<{ workspace: { id: string, slug: string, name: string } } | { blockedSlug: string | null }> {
  const db = useDatabaseProvider()
  const owned = await db.listOwnedWorkspacesAdmin(userId)
  if (!owned.length) throw createError({ statusCode: 500, message: errorMessage('generic.server_error') })
  const ordered = [...owned.filter(w => w.type === 'primary'), ...owned.filter(w => w.type !== 'primary')]
  let chosen: (typeof owned)[number] | undefined
  for (const w of ordered) {
    if (hasLiveSubscription(await db.getActivePaymentAccount(String(w.id)))) continue
    chosen = w
    break
  }
  if (!chosen) {
    const blocked = await db.getWorkspaceById(String(ordered[0]!.id), 'id, slug')
    return { blockedSlug: blocked ? String(blocked.slug) : null }
  }
  const row = await db.getWorkspaceById(String(chosen.id), 'id, slug, name')
  if (!row) throw createError({ statusCode: 500, message: errorMessage('generic.server_error') })
  return { workspace: { id: String(row.id), slug: String(row.slug), name: String(row.name) } }
}

/** A running plan already covers the order: join its workspace, charge Studio nothing, open no checkout. */
async function provisionCovered(claim: MigrateStudioClaimV2, userId: string): Promise<MigrateProvisionResponse> {
  const db = useDatabaseProvider()
  const workspace = await coveringWorkspace(userId, claim.plan)
  // The plan covered a moment ago and no longer does: Migrate re-asks the account state and re-quotes.
  if (!workspace) fail(409, 'migrate.quote_changed')
  const { grant } = await db.claimMigrateGrant({
    orderId: claim.order_id,
    claimJti: claim.jti,
    userId,
    plan: claim.plan,
    email: claim.email,
    origin: claim.origin ?? null,
    kind: 'bundle',
  })
  if (grant.user_id !== userId || grant.kind !== 'bundle') fail(409, 'migrate.claim_taken')
  if (grant.revoked_at) fail(409, 'migrate.grant_revoked')
  // A grant that was opened with a checkout (the account had no plan then) is not a covered one.
  if (grant.checkout_url && !grant.redeemed_at) fail(409, 'migrate.quote_changed')
  // A repeat finds the grant already tied to a workspace (its own, or the one the bundle was paid on): keep it.
  let target = workspace
  if (grant.workspace_id && grant.workspace_id !== workspace.id) {
    const tied = await db.getWorkspaceById(String(grant.workspace_id), 'id, slug')
    if (!tied) fail(500, 'generic.server_error')
    target = { id: String(tied.id), slug: String(tied.slug) }
  }
  const bound = await db.bindMigrateGrantWorkspace(String(grant.id), target.id)
  if (!bound) fail(409, 'migrate.grant_bound_elsewhere')
  // No subscription of its own: the customer's plan stays theirs (a later revoke cancels nothing of it).
  if (!bound.redeemed_at) await db.markMigrateGrantRedeemed(String(grant.id), null)

  const response: MigrateProvisionResponse = {
    grant_id: String(grant.id),
    state: 'redeemed',
    plan: claim.plan,
    workspace_slug: target.slug,
  }
  if (!validateMigrateProvisionResponse(response, { quoted_total_cents: claim.billing.quoted_total_cents }).ok)
    fail(502, 'billing.provider_unavailable')
  return response
}

export async function provisionMigrateBundle(claim: MigrateStudioClaimV2, now: Date = new Date()): Promise<MigrateProvisionResponse> {
  if (!isAllowedReturnUrl(claim.return_url, migrateExportOrigins())) fail(400, 'migrate.return_url_not_allowed')
  // An unverified email never creates or links an account.
  if (!claim.email_verified) fail(400, 'migrate.email_unverified')

  // Studio agrees the quote or refuses it; it never prices on this path.
  const account = await resolveMigrateAccountState(claim.github_user_id, claim.plan)
  if (account.state === 'too_small') fail(409, 'migrate.bundle_state_unsupported')
  if (claim.billing.migrate_fee_cents + account.year1_cents !== claim.billing.quoted_total_cents) fail(409, 'migrate.quote_changed')

  let user
  try {
    user = await useAuthProvider().ensureUserForProviderAccount({ provider: 'github', accountId: claim.github_user_id, email: claim.email })
  }
  catch (err) {
    if (err instanceof IdentityConflictError) fail(409, 'migrate.identity_conflict')
    throw err
  }

  const db = useDatabaseProvider()
  if (account.state === 'covers') return provisionCovered(claim, user.id)

  // No owned workspace is free of a subscription (e.g. the only one is on a plan that is ending): never a second one on it.
  // `data.code` is the stable handle Migrate matches on (the message is localised text); `workspace_slug` (a workspace the
  // caller owns, S2S only) is where Migrate sends the customer to resume the plan.
  const picked = await bundleWorkspace(user.id)
  if ('blockedSlug' in picked) {
    throw createError({ statusCode: 409, message: errorMessage('billing.subscription_exists'), data: { code: 'subscription_exists', ...(picked.blockedSlug ? { workspace_slug: picked.blockedSlug } : {}) } })
  }
  const { workspace } = picked

  const { grant } = await db.claimMigrateGrant({
    orderId: claim.order_id,
    claimJti: claim.jti,
    userId: user.id,
    plan: claim.plan,
    email: claim.email,
    origin: claim.origin ?? null,
    kind: 'bundle',
  })
  // The order belongs to another account, or was opened as something else: never reuse it.
  if (grant.user_id !== user.id || grant.kind !== 'bundle') fail(409, 'migrate.claim_taken')
  // Withdrawn after a refund or a failed delivery: a repeated provision must not reopen it.
  if (grant.revoked_at) fail(409, 'migrate.grant_revoked')
  if (grant.redeemed_at) fail(409, 'migrate.grant_used')
  const bound = await db.bindMigrateGrantWorkspace(String(grant.id), workspace.id)
  if (!bound) fail(409, 'migrate.grant_bound_elsewhere')
  // Paid in the same moment: the checkout answer never says redeemed, so refuse rather than hand out a used one.
  if (bound.redeemed_at) fail(409, 'migrate.grant_used')

  const quoted = claim.billing.quoted_total_cents
  const storedExpires = grant.checkout_expires_at ? new Date(String(grant.checkout_expires_at)) : null
  let checkoutUrl = grant.checkout_url as string | null
  let expiresAt = storedExpires
  if (!checkoutUrl || !storedExpires || grant.amount_cents !== quoted || storedExpires.getTime() - now.getTime() < MIN_REMAINING_MS) {
    const payment = usePaymentProvider()
    if (!payment) fail(503, 'generic.server_error')
    // Two provisions of one order in the same moment would open two checkouts: the second waits.
    const rate = await checkRateLimit(`migrate-provision:${claim.order_id}`, 1, 10_000)
    if (!rate.allowed) fail(429, 'auth.rate_limited')

    const siteUrl = useRuntimeConfig().public.siteUrl as string
    try {
      const checkout = await payment.createBundleCheckout({
        workspaceId: workspace.id,
        plan: claim.plan,
        customerEmail: claim.email,
        amountCents: quoted,
        successUrl: claim.return_url,
        metadata: {
          order_id: claim.order_id,
          tenant_id: claim.sub,
          migrate_grant_id: String(grant.id),
          migrate_bundle: 'true',
          studio_url: siteUrl,
        },
      })
      await db.saveMigrateGrantCheckout(String(grant.id), {
        checkoutId: checkout.sessionId,
        checkoutUrl: checkout.url,
        checkoutExpiresAt: checkout.expiresAt,
        amountCents: quoted,
        targetProductId: checkout.targetProductId,
      })
      checkoutUrl = checkout.url
      expiresAt = new Date(checkout.expiresAt)
    }
    catch (err) {
      // eslint-disable-next-line no-console -- ops visibility for provider failures
      console.error('[migrate-provision] createBundleCheckout failed:', err)
      throw createError({ statusCode: 502, message: errorMessage('billing.provider_unavailable') })
    }
  }

  const response: MigrateProvisionResponse = {
    grant_id: String(grant.id),
    state: 'bound',
    plan: claim.plan,
    workspace_slug: workspace.slug,
    checkout_url: checkoutUrl as string,
    amount_cents: quoted,
    checkout_expires_at: Math.floor((expiresAt as Date).getTime() / 1000),
  }
  // Fail closed on our own answer: Migrate redirects a browser to it.
  if (!validateMigrateProvisionResponse(response, { quoted_total_cents: quoted, now: Math.floor(now.getTime() / 1000) }).ok)
    fail(502, 'billing.provider_unavailable')
  return response
}

#!/usr/bin/env tsx
/* eslint-disable no-console -- CLI script: console output is the intended UX */
/**
 * Polar sync — content-driven product/price/meter bootstrap.
 *
 * Reads the single source of truth in `.contentrain/` and keeps the
 * Polar organisation aligned with it:
 *
 *   plans/en.json            → Polar products (Starter, Pro) + fixed monthly prices
 *   plan-features/data.json  → metered prices (one per overage-billable limit)
 *   shared/utils/usage-meters → Polar meters (create-if-missing)
 *
 * Idempotent. Safe to re-run on every deploy.
 *
 * Operations:
 *   - Meters: create-if-missing by name.
 *   - Products: matched by metadata.contentrain_slug first, then by name.
 *               Creates if missing. Updates name/description in place.
 *               Stamps metadata.contentrain_slug on unmarked existing products.
 *   - Fixed monthly price: created only if missing. If an existing price
 *     disagrees with the content (drift), the script warns and exits 1.
 *     Polar prices cannot be legally mutated once in use — price changes
 *     must be done manually in the dashboard (archive old → create new
 *     → set default) to protect active subscriptions.
 *   - Metered prices (overage): one per overage meter, per product.
 *     Created only if missing. Unit-amount drift triggers the same
 *     warning behaviour.
 *
 * Usage:
 *   NUXT_POLAR_ACCESS_TOKEN=polar_oat_… NUXT_POLAR_SERVER=sandbox \
 *     pnpm polar:sync
 */

import { Polar } from '@polar-sh/sdk'
import plansData from '../.contentrain/content/system/plans/en.json'
import planFeaturesData from '../.contentrain/content/system/plan-features/data.json'
import { USAGE_METER_LIST } from '../shared/utils/usage-meters'
import { OVERAGE_PRICING, PLAN_PRICING } from '../shared/utils/license'

// ─── Config ──────────────────────────────────────────────────────────────

const accessToken = process.env.NUXT_POLAR_ACCESS_TOKEN
const server = process.env.NUXT_POLAR_SERVER === 'production' ? 'production' : 'sandbox'

if (!accessToken) {
  console.error('NUXT_POLAR_ACCESS_TOKEN is required.')
  process.exit(1)
}

const polar = new Polar({ accessToken, server })

// Plans that get a Polar product. Free and Enterprise are omitted:
// free is a structural signup shell; enterprise is custom-contracted.
const BILLABLE_PLAN_SLUGS = ['starter', 'pro'] as const
type BillablePlan = (typeof BILLABLE_PLAN_SLUGS)[number]

interface PlanContent {
  name: string
  price_monthly: number
  description: string
}

const plans = plansData as unknown as Record<string, PlanContent>

interface PlanFeatureRow {
  key: string
  type: 'feature' | 'limit'
  overage_price?: number
  overage_settings_key?: string
}

const planFeatures = planFeaturesData as unknown as Record<string, PlanFeatureRow>

// ─── Helpers ─────────────────────────────────────────────────────────────

interface SyncSummary {
  meters: Record<string, string>
  products: Record<string, string>
  warnings: string[]
}

const summary: SyncSummary = { meters: {}, products: {}, warnings: [] }

function usdToCents(usd: number): number {
  return Math.round(usd * 100)
}

function unitCentsFromOverage(priceUsd: number): string {
  // Polar metered price unit_amount is in cents, supports up to 12 decimals.
  // Use string form to preserve sub-cent precision (e.g. $0.005 → "0.5").
  return (priceUsd * 100).toString()
}

async function listAllMeters(): Promise<Array<{ id: string, name: string }>> {
  const out: Array<{ id: string, name: string }> = []
  const iterator = await polar.meters.list({})
  for await (const page of iterator) {
    const items = (page.result?.items ?? []) as Array<{ id?: string, name?: string }>
    for (const item of items) {
      if (item.id && item.name) out.push({ id: item.id, name: item.name })
    }
  }
  return out
}

async function listAllProducts(): Promise<Array<{
  id: string
  name: string
  description: string | null
  isArchived: boolean
  metadata: Record<string, unknown>
  prices: Array<Record<string, unknown>>
}>> {
  const out: Array<{
    id: string
    name: string
    description: string | null
    isArchived: boolean
    metadata: Record<string, unknown>
    prices: Array<Record<string, unknown>>
  }> = []
  const iterator = await polar.products.list({ isArchived: false })
  for await (const page of iterator) {
    const items = (page.result?.items ?? []) as Array<{
      id: string
      name: string
      description: string | null
      isArchived: boolean
      metadata: Record<string, unknown>
      prices: Array<Record<string, unknown>>
    }>
    out.push(...items)
  }
  return out
}

// ─── Meter sync ──────────────────────────────────────────────────────────

async function syncMeters(existingMeters: Array<{ id: string, name: string }>): Promise<Map<string, string>> {
  const byName = new Map(existingMeters.map(m => [m.name, m.id]))

  for (const meter of USAGE_METER_LIST) {
    if (byName.has(meter.name)) {
      console.log(`  ✓ meter "${meter.name}" exists (${byName.get(meter.name)})`)
      continue
    }
    // Count aggregation for discrete events, sum(value) for continuous.
    const usesSumAggregation = meter.name === 'cdn_bandwidth_bytes' || meter.name === 'media_storage_byte_hours'
    try {
      const created = await polar.meters.create({
        name: meter.name,
        filter: {
          conjunction: 'and',
          clauses: [{ property: 'name', operator: 'eq', value: meter.name }],
        },
        aggregation: usesSumAggregation
          ? { func: 'sum', property: 'value' }
          : { func: 'count' },
      })
      byName.set(meter.name, created.id)
      summary.meters[meter.name] = created.id
      console.log(`  + meter "${meter.name}" created (${created.id})`)
    }
    catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      summary.warnings.push(`Failed to create meter "${meter.name}": ${msg}`)
      console.error(`  ✗ meter "${meter.name}" failed: ${msg}`)
    }
  }

  return byName
}

// ─── Product sync ────────────────────────────────────────────────────────

function findExistingProduct(
  products: Array<{ id: string, name: string, metadata: Record<string, unknown> }>,
  slug: BillablePlan,
  displayName: string,
) {
  // Primary: metadata.contentrain_slug. Secondary: case-insensitive name match
  // (covers products that were created manually before this script existed).
  const byMeta = products.find(p => p.metadata?.contentrain_slug === slug)
  if (byMeta) return byMeta
  return products.find(p => p.name.trim().toLowerCase() === displayName.toLowerCase())
}

interface ProductPriceRow {
  id: string
  amountType?: string
  amount_type?: string
  priceAmount?: number
  price_amount?: number
  unitAmount?: number | string
  unit_amount?: number | string
  meterId?: string
  meter_id?: string
  isArchived?: boolean
  is_archived?: boolean
}

function getPriceType(price: Record<string, unknown>): string | undefined {
  const row = price as ProductPriceRow
  return row.amountType ?? row.amount_type
}

function getFixedPriceAmount(price: Record<string, unknown>): number | undefined {
  const row = price as ProductPriceRow
  return row.priceAmount ?? row.price_amount
}

function getMeteredPriceMeterId(price: Record<string, unknown>): string | undefined {
  const row = price as ProductPriceRow
  return row.meterId ?? row.meter_id
}

function getMeteredPriceUnitAmount(price: Record<string, unknown>): string | undefined {
  const row = price as ProductPriceRow
  const value = row.unitAmount ?? row.unit_amount
  return value === undefined ? undefined : String(value)
}

function isPriceArchived(price: Record<string, unknown>): boolean {
  const row = price as ProductPriceRow
  return Boolean(row.isArchived ?? row.is_archived)
}

/**
 * Build the metered-price entries a product needs, keyed by meterId.
 * Uses OVERAGE_PRICING + the resolved meter-name → meter-id map.
 */
function buildMeteredPriceBlueprint(meterIdByName: Map<string, string>): Array<{
  meterId: string
  meterName: string
  unitAmountCents: string
}> {
  const out: Array<{ meterId: string, meterName: string, unitAmountCents: string }> = []
  for (const [limitKey, entry] of Object.entries(OVERAGE_PRICING)) {
    // Match the OVERAGE_PRICING entry to a USAGE_METERS name via the
    // settings key. They are not 1:1 because meter names are developer-
    // facing slugs — we read them off plan-features rows directly.
    const row = Object.values(planFeatures).find(r =>
      r.type === 'limit'
      && r.key === limitKey
      && r.overage_settings_key === entry.settingsKey,
    )
    if (!row) continue
    // Find the corresponding USAGE_METERS entry by settingsKey.
    const meterDef = USAGE_METER_LIST.find(m => m.settingsKey === entry.settingsKey)
    if (!meterDef) continue
    const meterId = meterIdByName.get(meterDef.name)
    if (!meterId) {
      summary.warnings.push(`Meter "${meterDef.name}" missing; skipping metered price for ${limitKey}`)
      continue
    }
    out.push({
      meterId,
      meterName: meterDef.name,
      unitAmountCents: unitCentsFromOverage(entry.price),
    })
  }
  return out
}

async function syncProduct(
  slug: BillablePlan,
  meterIdByName: Map<string, string>,
  existingProducts: Awaited<ReturnType<typeof listAllProducts>>,
): Promise<void> {
  const plan = plans[slug]!
  const pricing = PLAN_PRICING[slug]
  const fixedPriceCents = usdToCents(plan.price_monthly)
  const meteredBlueprint = buildMeteredPriceBlueprint(meterIdByName)

  const existing = findExistingProduct(existingProducts, slug, pricing.name)

  if (!existing) {
    // Fresh create: one fixed recurring price + six metered prices.
    try {
      const created = await polar.products.create({
        recurringInterval: 'month',
        name: pricing.name,
        description: plan.description,
        metadata: { contentrain_slug: slug },
        prices: [
          { amountType: 'fixed', priceAmount: fixedPriceCents },
          ...meteredBlueprint.map(m => ({
            amountType: 'metered_unit' as const,
            meterId: m.meterId,
            unitAmount: m.unitAmountCents,
          })),
        ],
      })
      summary.products[slug] = created.id
      console.log(`  + product "${pricing.name}" created (${created.id}) — $${plan.price_monthly}/mo + ${meteredBlueprint.length} metered prices`)
    }
    catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      summary.warnings.push(`Failed to create product "${pricing.name}": ${msg}`)
      console.error(`  ✗ product "${pricing.name}" failed: ${msg}`)
    }
    return
  }

  // Existing product — update mutable fields in place and reconcile prices.
  summary.products[slug] = existing.id
  const updates: Record<string, unknown> = {}
  if (existing.name !== pricing.name) updates.name = pricing.name
  if ((existing.description ?? '') !== plan.description) updates.description = plan.description
  if (existing.metadata?.contentrain_slug !== slug) {
    updates.metadata = { ...existing.metadata, contentrain_slug: slug }
  }

  // Reconcile prices: keep every existing (unarchived) price, detect drift,
  // append any missing metered prices.
  const prices = existing.prices.filter(p => !isPriceArchived(p))
  const fixedPrice = prices.find(p => getPriceType(p) === 'fixed')
  const meteredPrices = prices.filter(p => getPriceType(p) === 'metered_unit')

  if (fixedPrice) {
    const current = getFixedPriceAmount(fixedPrice)
    if (current !== fixedPriceCents) {
      summary.warnings.push(
        `Fixed price drift on "${pricing.name}": Polar has ${current} cents, content wants ${fixedPriceCents} cents. `
        + `Archive the old price in the Polar dashboard and create a new one to change prices — the script refuses to mutate prices automatically to protect active subscriptions.`,
      )
    }
  }

  const meteredByMeterId = new Map(meteredPrices.map(p => [getMeteredPriceMeterId(p), p] as const))
  const missingMeteredPrices: Array<{ meterId: string, meterName: string, unitAmountCents: string }> = []
  for (const blueprint of meteredBlueprint) {
    const current = meteredByMeterId.get(blueprint.meterId)
    if (!current) {
      missingMeteredPrices.push(blueprint)
      continue
    }
    const currentUnit = getMeteredPriceUnitAmount(current)
    if (currentUnit !== blueprint.unitAmountCents) {
      summary.warnings.push(
        `Metered price drift on "${pricing.name}" (meter "${blueprint.meterName}"): `
        + `Polar has unit_amount=${currentUnit ?? 'unknown'} cents, content wants ${blueprint.unitAmountCents} cents.`,
      )
    }
  }

  const mustUpdatePrices = missingMeteredPrices.length > 0
  const mustUpdateMeta = Object.keys(updates).length > 0

  if (!mustUpdateMeta && !mustUpdatePrices) {
    console.log(`  ✓ product "${pricing.name}" in sync (${existing.id})`)
    return
  }

  try {
    // Carry existing prices by id; append missing metered prices as creates.
    // Polar treats prices as a set — omitting is NOT an archive, update only
    // touches names, description, metadata, and new price creates.
    const preservedPrices = prices.map(p => ({ id: (p as ProductPriceRow).id }))
    const newPrices = missingMeteredPrices.map(m => ({
      amountType: 'metered_unit' as const,
      meterId: m.meterId,
      unitAmount: m.unitAmountCents,
    }))
    await polar.products.update({
      id: existing.id,
      productUpdate: {
        ...updates,
        prices: mustUpdatePrices ? [...preservedPrices, ...newPrices] : undefined,
      },
    })
    const delta: string[] = []
    if (updates.name) delta.push('name')
    if (updates.description) delta.push('description')
    if (updates.metadata) delta.push('metadata')
    if (mustUpdatePrices) delta.push(`+${newPrices.length} metered price(s)`)
    console.log(`  ~ product "${pricing.name}" updated (${existing.id}) — ${delta.join(', ')}`)
  }
  catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    summary.warnings.push(`Failed to update product "${pricing.name}": ${msg}`)
    console.error(`  ✗ product "${pricing.name}" update failed: ${msg}`)
  }
}

// ─── Main ────────────────────────────────────────────────────────────────

async function main() {
  console.log(`[polar-sync] server=${server}`)

  console.log('\n[polar-sync] step 1/2 — syncing meters')
  const existingMeters = await listAllMeters()
  const meterIdByName = await syncMeters(existingMeters)

  console.log('\n[polar-sync] step 2/2 — syncing products + prices')
  const existingProducts = await listAllProducts()
  for (const slug of BILLABLE_PLAN_SLUGS) {
    await syncProduct(slug, meterIdByName, existingProducts)
  }

  console.log('\n[polar-sync] summary')
  if (summary.warnings.length > 0) {
    console.log('  warnings:')
    for (const w of summary.warnings) console.log(`    ! ${w}`)
  }

  const meterLines = Object.entries(summary.meters).map(([name, id]) => `  - ${name}: ${id}`).join('\n')
  if (meterLines) console.log(`  created meters:\n${meterLines}`)

  const productLines = Object.entries(summary.products).map(([slug, id]) => `  NUXT_POLAR_${slug.toUpperCase()}_PRODUCT_ID=${id}`).join('\n')
  if (productLines) {
    console.log(`\n  paste these into .env.local (or your deployment env):\n${productLines}`)
  }

  console.log('\n[polar-sync] done')

  if (summary.warnings.length > 0) {
    // Exit 1 on price drift so CI surfaces the manual-fix requirement loudly.
    process.exit(1)
  }
}

main().catch((err) => {
  console.error('[polar-sync] unhandled error:', err)
  process.exit(1)
})

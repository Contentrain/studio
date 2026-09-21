#!/usr/bin/env tsx
/// <reference types="node" />
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
 *   - Included units (meter credits): a Polar `metered_unit` price has no
 *     "included units" field — it bills from the first unit. The included
 *     allowance is a product-level benefit of type `meter_credit`
 *     (`units`, `rollover`, `meter_id`). Without one, a customer pays the
 *     plan price AND per-unit for the quota the plan says is included.
 *     One benefit per plan per metered limit, units = that plan's limit.
 *
 * Writes are opt-in. The default is a dry run that prints the diff and
 * changes nothing; `--apply` performs it.
 *
 * Usage:
 *   NUXT_POLAR_ACCESS_TOKEN=polar_oat_… NUXT_POLAR_SERVER=sandbox \
 *     pnpm polar:sync                  # dry run — prints the diff
 *     pnpm polar:sync --apply          # perform it
 *     pnpm polar:sync --apply --rotate-prices
 *                                      # also replace drifted unit prices
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

/**
 * Writes are opt-in. A sync script that mutates a live billing catalogue
 * the moment it is run is a script nobody can safely use to *look*.
 */
const APPLY = process.argv.includes('--apply')
/**
 * Replacing a drifted unit price means creating a new one: Polar prices
 * cannot be mutated once in use. Gated separately from `--apply` because
 * it changes what existing subscribers are charged.
 */
const ROTATE_PRICES = process.argv.includes('--rotate-prices')

/** Stand-in id for a meter a dry run would create but has not. */
const PENDING_METER_ID = '(pending-create)'

/** Polar caps `meter_credit.units` at int32 and the description at 42 chars. */
const MAX_BENEFIT_UNITS = 2_147_483_647
const MAX_BENEFIT_DESCRIPTION = 42

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
  starter_value?: string
  pro_value?: string
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
  // Fixed notation, not `toString()`: a per-byte rate is small enough that
  // JavaScript switches to exponent form ("9.3e-9"), which Polar rejects.
  // Trailing zeros are trimmed so $0.005 still reads "0.5".
  const cents = priceUsd * 100
  const fixed = cents.toFixed(12).replace(/0+$/, '').replace(/\.$/, '')
  return fixed === '' || fixed === '-0' ? '0' : fixed
}

async function listAllMeters(): Promise<Array<{ id: string, name: string, aggregationFunc?: string }>> {
  const out: Array<{ id: string, name: string, aggregationFunc?: string }> = []
  const iterator = await polar.meters.list({})
  for await (const page of iterator) {
    const items = (page.result?.items ?? []) as Array<{ id?: string, name?: string, aggregation?: { func?: string } }>
    for (const item of items) {
      if (item.id && item.name) out.push({ id: item.id, name: item.name, aggregationFunc: item.aggregation?.func })
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
  benefits?: Array<Record<string, unknown>>
}>> {
  const out: Array<{
    id: string
    name: string
    description: string | null
    isArchived: boolean
    metadata: Record<string, unknown>
    prices: Array<Record<string, unknown>>
    benefits?: Array<Record<string, unknown>>
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
      benefits?: Array<Record<string, unknown>>
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
    const usesSumAggregation = meter.aggregation === 'sum'
    // A meter that counts events bills one per ingest call. That is right
    // for a meter whose events always carry value 1 (a submission, an MCP
    // call), and wrong for the credit meters since credit weighting
    // landed: a heavy turn emits one base event plus one top-up event
    // carrying N extra credits, so `count` bills 2 where the ledger says
    // N+1. Existing meters are never re-aggregated here — changing an
    // aggregation under recorded events would restate history — so this
    // only reports it.
    const existing = existingMeters.find(m => m.name === meter.name)
    if (existing && existing.aggregationFunc && existing.aggregationFunc !== (usesSumAggregation ? 'sum' : 'count')) {
      summary.warnings.push(
        `Meter "${meter.name}" aggregates by ${existing.aggregationFunc}, the manifest says ${usesSumAggregation ? 'sum' : 'count'}. `
        + `Aggregation cannot be changed under recorded events without restating history — create a new meter instead.`,
      )
    }
    try {
      if (!APPLY) {
        console.log(`  + meter "${meter.name}" would be created (aggregation: ${usesSumAggregation ? 'sum(value)' : 'count'})`)
        // Give the rest of the dry run something to plan against. Without
        // a placeholder every price and included allowance that depends on
        // a not-yet-created meter drops out, and the diff the founder is
        // asked to approve silently omits the new meters' whole cost side.
        byName.set(meter.name, PENDING_METER_ID)
        continue
      }
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

type ProductSummary = Awaited<ReturnType<typeof listAllProducts>>[number]

function findExistingProduct(
  products: ProductSummary[],
  slug: BillablePlan,
  displayName: string,
): ProductSummary | undefined {
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
  const row = price as unknown as ProductPriceRow
  return row.amountType ?? row.amount_type
}

function getFixedPriceAmount(price: Record<string, unknown>): number | undefined {
  const row = price as unknown as ProductPriceRow
  return row.priceAmount ?? row.price_amount
}

function getMeteredPriceMeterId(price: Record<string, unknown>): string | undefined {
  const row = price as unknown as ProductPriceRow
  return row.meterId ?? row.meter_id
}

function getMeteredPriceUnitAmount(price: Record<string, unknown>): string | undefined {
  const row = price as unknown as ProductPriceRow
  const value = row.unitAmount ?? row.unit_amount
  return value === undefined ? undefined : String(value)
}

function isPriceArchived(price: Record<string, unknown>): boolean {
  const row = price as unknown as ProductPriceRow
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
    // Price per *meter* unit, not per plan-limit unit.
    out.push({
      meterId,
      meterName: meterDef.name,
      unitAmountCents: unitCentsFromOverage(entry.price / meterDef.unitsPerLimitUnit),
    })
  }
  return out
}

/**
 * The allowance a plan includes for one metered limit, or null when the
 * plan grants none (0) or an unmetered amount ("unlimited").
 */
function includedUnitsFor(slug: BillablePlan, limitKey: string): number | null {
  const row = Object.values(planFeatures).find(r => r.type === 'limit' && r.key === limitKey)
  if (!row) return null
  const raw = slug === 'pro' ? row.pro_value : row.starter_value
  if (raw === undefined || raw === null) return null
  if (raw === 'unlimited') return null
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) return null
  return n
}

/** Polar rejects anything longer than 42 characters here. */
function creditDescription(slug: BillablePlan, item: { units: number, meterName: string }): string {
  const full = `${PLAN_PRICING[slug].name}: ${item.units} ${item.meterName}`
  return full.length <= MAX_BENEFIT_DESCRIPTION ? full : `${full.slice(0, MAX_BENEFIT_DESCRIPTION - 1)}…`
}

/** Stable identity for a benefit this script owns. */
function creditBenefitKey(slug: BillablePlan, meterName: string): string {
  return `contentrain:${slug}:${meterName}`
}

interface CreditBenefitPlan {
  meterName: string
  meterId: string
  units: number
  existingId?: string
  existingUnits?: number
}

/**
 * Reconcile the `meter_credit` benefits for one product.
 *
 * Without these, every metered price bills from the first unit and the
 * customer pays twice for what the plan says is included. The units come
 * from the same plan-features rows the app enforces its limits with, so
 * the invoice and the usage screen agree by construction.
 *
 * `rollover: false` — Studio's quota does not carry over; a new period
 * opens a new counter.
 */
async function syncMeterCredits(
  slug: BillablePlan,
  productId: string,
  meterIdByName: Map<string, string>,
  existingBenefits: Array<Record<string, unknown>>,
): Promise<void> {
  const planned: CreditBenefitPlan[] = []

  for (const entry of Object.values(OVERAGE_PRICING)) {
    const meterDef = USAGE_METER_LIST.find(m => m.settingsKey === entry.settingsKey)
    if (!meterDef) continue
    const meterId = meterIdByName.get(meterDef.name)
    if (!meterId) continue
    const limitUnits = includedUnitsFor(slug, meterDef.limitKey)
    if (limitUnits === null) continue
    const units = Math.round(limitUnits * meterDef.unitsPerLimitUnit)

    // A meter that does not count what the plan sells cannot carry the
    // plan's allowance. Polar caps `units` at int32, and a gigabyte
    // allowance counted in bytes blows past it — 2 GB is already one byte
    // over. Refusing by *unit* rather than by size matters: Starter's 1 GB
    // fits int32 while Pro's 15 GB does not, so a size check would grant
    // the cheaper plan an allowance and the dearer one none.
    if (meterDef.unitsPerLimitUnit !== 1 || units > MAX_BENEFIT_UNITS) {
      summary.warnings.push(
        `Cannot include ${limitUnits} ${meterDef.limitKey} on ${slug}: the meter counts ${meterDef.unitLabel}s `
        + `(${units} of them, and Polar caps a meter credit at ${MAX_BENEFIT_UNITS}). `
        + `This meter has to count the unit the plan sells before an allowance can be expressed; until then every unit bills.`,
      )
      continue
    }

    const key = creditBenefitKey(slug, meterDef.name)
    const found = existingBenefits.find(b =>
      (b.metadata as Record<string, unknown> | undefined)?.contentrain_key === key,
    )
    const props = found?.properties as { units?: number } | undefined
    planned.push({
      meterName: meterDef.name,
      meterId,
      units,
      existingId: found?.id as string | undefined,
      existingUnits: props?.units,
    })
  }

  if (planned.length === 0) return

  const benefitIds: string[] = []
  for (const item of planned) {
    if (item.existingId && item.existingUnits === item.units) {
      benefitIds.push(item.existingId)
      console.log(`    ✓ included ${item.units} ${item.meterName}`)
      continue
    }

    if (item.existingId) {
      console.log(`    ~ included units drift on ${item.meterName}: Polar has ${item.existingUnits ?? 'unknown'}, content wants ${item.units}`)
      if (!APPLY) {
        benefitIds.push(item.existingId)
        continue
      }
      try {
        await polar.benefits.update({
          id: item.existingId,
          requestBody: {
            type: 'meter_credit',
            properties: { units: item.units, rollover: false, meterId: item.meterId },
          },
        })
        benefitIds.push(item.existingId)
      }
      catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        summary.warnings.push(`Failed to update meter credit for ${slug}/${item.meterName}: ${msg}`)
        benefitIds.push(item.existingId)
      }
      continue
    }

    console.log(`    + include ${item.units} ${item.meterName} (meter credit)`)
    if (!APPLY) continue
    try {
      const created = await polar.benefits.create({
        type: 'meter_credit',
        description: creditDescription(slug, item),
        metadata: { contentrain_key: creditBenefitKey(slug, item.meterName) },
        properties: { units: item.units, rollover: false, meterId: item.meterId },
      } as never)
      benefitIds.push((created as unknown as { id: string }).id)
    }
    catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      summary.warnings.push(`Failed to create meter credit for ${slug}/${item.meterName}: ${msg}`)
    }
  }

  if (!APPLY || benefitIds.length === 0) return

  // Attach. Benefits this script does not own are preserved — the call
  // replaces the whole set, so dropping them would silently remove
  // anything configured by hand in the dashboard.
  const foreign = existingBenefits
    .filter(b => !(b.metadata as Record<string, unknown> | undefined)?.contentrain_key)
    .map(b => b.id as string)
  try {
    await polar.products.updateBenefits({
      id: productId,
      productBenefitsUpdate: { benefits: [...foreign, ...benefitIds] },
    })
  }
  catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    summary.warnings.push(`Failed to attach meter credits to ${slug}: ${msg}`)
  }
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
    if (!APPLY) {
      console.log(`  + product "${pricing.name}" would be created — $${plan.price_monthly}/mo + ${meteredBlueprint.length} metered prices`)
      return
    }
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
  const driftedPrices: Array<{ blueprint: { meterId: string, meterName: string, unitAmountCents: string }, oldPriceId: string }> = []
  for (const blueprint of meteredBlueprint) {
    const current = meteredByMeterId.get(blueprint.meterId)
    if (!current) {
      missingMeteredPrices.push(blueprint)
      continue
    }
    const currentUnit = getMeteredPriceUnitAmount(current)
    // Polar echoes unit_amount back as a 12-decimal string
    // ("10.000000000000"); compare numerically or every in-sync price
    // reads as drift and the sync exits 1 forever.
    if (currentUnit === undefined || Number(currentUnit) !== Number(blueprint.unitAmountCents)) {
      if (ROTATE_PRICES) {
        // A price cannot be mutated once in use, so rotating means adding
        // the new one and dropping the old from the product's price set.
        driftedPrices.push({ blueprint, oldPriceId: (current as unknown as ProductPriceRow).id })
        console.log(`    ~ rotate ${blueprint.meterName}: ${currentUnit ?? 'unknown'} → ${blueprint.unitAmountCents} cents/unit`)
      }
      else {
        summary.warnings.push(
          `Metered price drift on "${pricing.name}" (meter "${blueprint.meterName}"): `
          + `Polar has unit_amount=${currentUnit ?? 'unknown'} cents, content wants ${blueprint.unitAmountCents} cents. `
          + `Re-run with --rotate-prices --apply to replace it.`,
        )
      }
    }
  }

  // A metered price whose meter the manifest no longer lists is left over
  // from a renamed meter. Studio stops ingesting to it, so it bills
  // nothing — but leaving it attached means the product advertises two
  // prices for the same thing, and anything that does emit the old event
  // name gets billed twice.
  const knownMeterIds = new Set(meteredBlueprint.map(m => m.meterId))
  const staleMeteredPrices = ROTATE_PRICES
    ? meteredPrices.filter(price => !knownMeterIds.has(getMeteredPriceMeterId(price) ?? ''))
    : []
  for (const price of staleMeteredPrices) {
    const meterName = (price.meter as { name?: string } | undefined)?.name ?? getMeteredPriceMeterId(price)
    console.log(`    - drop stale price for meter "${meterName}" (no longer in the manifest)`)
  }
  if (!ROTATE_PRICES) {
    const stale = meteredPrices.filter(price => !knownMeterIds.has(getMeteredPriceMeterId(price) ?? ''))
    for (const price of stale) {
      const meterName = (price.meter as { name?: string } | undefined)?.name ?? getMeteredPriceMeterId(price)
      summary.warnings.push(
        `"${pricing.name}" still carries a metered price for "${meterName}", which the manifest no longer lists. `
        + `Re-run with --rotate-prices --apply to detach it.`,
      )
    }
  }

  const mustUpdatePrices = missingMeteredPrices.length > 0 || driftedPrices.length > 0 || staleMeteredPrices.length > 0
  const mustUpdateMeta = Object.keys(updates).length > 0

  if (!mustUpdateMeta && !mustUpdatePrices) {
    console.log(`  ✓ product "${pricing.name}" prices in sync (${existing.id})`)
    await syncMeterCredits(slug, existing.id, meterIdByName, existing.benefits ?? [])
    return
  }

  try {
    // Carry existing prices by id; append missing metered prices as creates.
    // Polar treats prices as a set — omitting is NOT an archive, update only
    // touches names, description, metadata, and new price creates.
    const rotatedOut = new Set([
      ...driftedPrices.map(d => d.oldPriceId),
      ...staleMeteredPrices.map(p => (p as unknown as ProductPriceRow).id),
    ])
    const preservedPrices = prices
      .filter(p => !rotatedOut.has((p as unknown as ProductPriceRow).id))
      .map(p => ({ id: (p as unknown as ProductPriceRow).id }))
    const newPrices = [...missingMeteredPrices, ...driftedPrices.map(d => d.blueprint)].map(m => ({
      amountType: 'metered_unit' as const,
      meterId: m.meterId,
      unitAmount: m.unitAmountCents,
    }))
    if (!APPLY) {
      const what: string[] = []
      if (mustUpdateMeta) what.push(Object.keys(updates).join('/'))
      if (missingMeteredPrices.length) what.push(`+${missingMeteredPrices.length} metered price(s)`)
      if (driftedPrices.length) what.push(`rotate ${driftedPrices.length} price(s)`)
      if (staleMeteredPrices.length) what.push(`drop ${staleMeteredPrices.length} stale price(s)`)
      console.log(`  ~ product "${pricing.name}" would be updated — ${what.join(', ')}`)
      await syncMeterCredits(slug, existing.id, meterIdByName, existing.benefits ?? [])
      return
    }
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
    if (mustUpdatePrices) delta.push(`${newPrices.length} metered price(s)`)
    console.log(`  ~ product "${pricing.name}" updated (${existing.id}) — ${delta.join(', ')}`)
    await syncMeterCredits(slug, existing.id, meterIdByName, existing.benefits ?? [])
  }
  catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    summary.warnings.push(`Failed to update product "${pricing.name}": ${msg}`)
    console.error(`  ✗ product "${pricing.name}" update failed: ${msg}`)
  }
}

// ─── Main ────────────────────────────────────────────────────────────────

async function main() {
  console.log(`[polar-sync] server=${server} mode=${APPLY ? 'APPLY' : 'dry-run'}${ROTATE_PRICES ? ' rotate-prices' : ''}`)
  if (!APPLY) console.log('[polar-sync] dry run — nothing will be written. Re-run with --apply to perform it.')

  console.log('\n[polar-sync] step 1/2 — syncing meters')
  const existingMeters = await listAllMeters()
  const meterIdByName = await syncMeters(existingMeters)

  console.log('\n[polar-sync] step 2/2 — syncing products, prices + included units')
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

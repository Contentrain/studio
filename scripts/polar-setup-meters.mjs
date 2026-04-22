#!/usr/bin/env node
/* eslint-disable no-console -- CLI script: console output is the intended UX */
/**
 * Polar meter bootstrap script.
 *
 * Creates the six Contentrain meters on a Polar organisation. Idempotent:
 * re-running skips meters whose `name` already exists.
 *
 * Usage:
 *   NUXT_POLAR_ACCESS_TOKEN=polar_oat_… NUXT_POLAR_SERVER=sandbox \
 *     node ./scripts/polar-setup-meters.mjs
 *
 * The meter names here must match the ones emitted by the Polar payment
 * plugin (see `shared/utils/usage-meters.ts`). If you rename a meter on
 * this side, you must rename it in Polar too.
 */

import { Polar } from '@polar-sh/sdk'

const accessToken = process.env.NUXT_POLAR_ACCESS_TOKEN
const server = process.env.NUXT_POLAR_SERVER === 'production' ? 'production' : 'sandbox'

if (!accessToken) {
  console.error('NUXT_POLAR_ACCESS_TOKEN is required.')
  process.exit(1)
}

const polar = new Polar({ accessToken, server })

/**
 * Meter definitions — one per Contentrain usage category.
 *
 * `aggregation.func='count'` counts matching events (good for discrete
 * actions like AI message sent, form submitted). `aggregation.func='sum'`
 * sums the numeric `value` metadata (good for continuous quantities like
 * CDN bytes or storage byte·hours).
 */
const METERS = [
  {
    name: 'ai_messages',
    filter: { conjunction: 'and', clauses: [{ property: 'name', operator: 'eq', value: 'ai_messages' }] },
    aggregation: { func: 'count' },
  },
  {
    name: 'api_messages',
    filter: { conjunction: 'and', clauses: [{ property: 'name', operator: 'eq', value: 'api_messages' }] },
    aggregation: { func: 'count' },
  },
  {
    name: 'mcp_calls',
    filter: { conjunction: 'and', clauses: [{ property: 'name', operator: 'eq', value: 'mcp_calls' }] },
    aggregation: { func: 'count' },
  },
  {
    name: 'form_submissions',
    filter: { conjunction: 'and', clauses: [{ property: 'name', operator: 'eq', value: 'form_submissions' }] },
    aggregation: { func: 'count' },
  },
  {
    name: 'cdn_bandwidth_bytes',
    filter: { conjunction: 'and', clauses: [{ property: 'name', operator: 'eq', value: 'cdn_bandwidth_bytes' }] },
    aggregation: { func: 'sum', property: 'value' },
  },
  {
    name: 'media_storage_byte_hours',
    filter: { conjunction: 'and', clauses: [{ property: 'name', operator: 'eq', value: 'media_storage_byte_hours' }] },
    aggregation: { func: 'sum', property: 'value' },
  },
]

async function listExistingNames() {
  const existing = new Set()
  const iterator = await polar.meters.list({})
  for await (const page of iterator) {
    for (const meter of page.result?.items ?? []) {
      if (meter?.name) existing.add(meter.name)
    }
  }
  return existing
}

async function main() {
  console.log(`[polar-meters] server=${server}`)
  const existing = await listExistingNames()

  for (const meter of METERS) {
    if (existing.has(meter.name)) {
      console.log(`[polar-meters] skip ${meter.name} (already exists)`)
      continue
    }
    try {
      const created = await polar.meters.create(meter)
      console.log(`[polar-meters] created ${meter.name} -> ${created.id}`)
    }
    catch (err) {
      console.error(`[polar-meters] failed to create ${meter.name}:`, err instanceof Error ? err.message : err)
      process.exitCode = 1
    }
  }

  console.log('[polar-meters] done')
}

main().catch((err) => {
  console.error('[polar-meters] unhandled error:', err)
  process.exit(1)
})

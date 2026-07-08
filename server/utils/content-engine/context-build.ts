/**
 * Studio-side `context.json` builder.
 *
 * Post-merge context regeneration previously called MCP's
 * `buildContextChange`, which walks the repo file-by-file over the
 * GitHub reader: readConfig + listModels + readModel×M + countEntries×M
 * ≈ O(models × locales) API calls per merge. The brain snapshot already
 * holds the same data, refreshed incrementally for ~1-3 calls — so the
 * stats can be derived from it with zero extra reads.
 *
 * Output is byte-compatible with MCP's shape (same `canonicalStringify`
 * from `@contentrain/types`, same object literal, same key set):
 *
 *   { version, lastOperation: { tool, model, locale, entries, timestamp,
 *     source }, stats: { models, entries, locales, lastSync } }
 *
 * Entry counting mirrors MCP `countEntries` for the default `file`
 * locale strategy (the only layout the brain reads):
 * - collection: per-locale key count, SUMMED across locales
 * - document:   per-locale entries-array length, summed (slug × locale)
 * - singleton/dictionary: 1 per locale key present
 * - a model with NO content keys at all → total collapses to `null`
 *   (mirrors MCP, where a missing content directory throws inside
 *   `computeEntriesCount` and nulls the whole total)
 *
 * Known residual divergences (callers keep the MCP walk as fallback and
 * context regen is best-effort/self-healing by contract): non-default
 * `locale_strategy` models (we return null → fallback), locale files
 * outside `config.locales.supported`, model files without an `id`.
 */

import type { FileChange } from '@contentrain/types'
import { canonicalStringify } from '@contentrain/types'
import type { BrainCacheEntry } from '../brain-cache'
import { resolveContextPath } from '../content-paths'

export interface ContextOperation {
  tool: string
  model: string
  locale?: string
  entries?: number
}

/**
 * Build the context.json FileChange from a brain snapshot.
 * Returns `null` when the snapshot can't stand in for the MCP walk —
 * the caller must fall back to `buildContextChange`.
 */
export function buildContextChangeFromBrain(
  brain: BrainCacheEntry,
  pathCtx: { contentRoot: string },
  operation: ContextOperation,
): FileChange | null {
  const config = brain.config
  if (!config) return null

  // The brain only reads the default `file` locale strategy; models on
  // other strategies would be counted wrong — punt to the MCP walk.
  for (const model of brain.models.values()) {
    const strategy = (model as { locale_strategy?: string }).locale_strategy
    if (strategy && strategy !== 'file') return null
  }

  const timestamp = new Date().toISOString()
  const content = canonicalStringify({
    version: '1',
    lastOperation: {
      tool: operation.tool,
      model: operation.model,
      locale: operation.locale ?? config.locales?.default ?? 'en',
      // `undefined` is dropped by JSON.stringify — same as MCP on merges.
      entries: operation.entries,
      timestamp,
      source: 'mcp-studio',
    },
    stats: {
      models: brain.models.size,
      entries: computeTotalEntries(brain),
      locales: config.locales?.supported ?? ['en'],
      lastSync: timestamp,
    },
  })

  return { path: resolveContextPath(pathCtx), content }
}

/**
 * Total entry count across all models, MCP `countEntries` parity rules.
 * NOT `contentSummary[m].count` — that is a per-model `Math.max` across
 * locales, while MCP sums across locales.
 */
export function computeTotalEntries(brain: BrainCacheEntry): number | null {
  let total = 0

  for (const [modelId, model] of brain.models) {
    const kind = (model.kind ?? 'collection') as string
    let sawKey = false

    for (const [key, value] of brain.content) {
      if (!key.startsWith(`${modelId}:`)) continue
      sawKey = true

      if (kind === 'document') {
        if (Array.isArray(value)) total += value.length
      }
      else if (kind === 'collection') {
        if (Array.isArray(value)) total += value.length
        else if (value && typeof value === 'object') total += Object.keys(value).length
      }
      else {
        // singleton / dictionary: one entry per locale file present
        if (value !== null && value !== undefined) total += 1
      }
    }

    if (!sawKey) return null
  }

  return total
}

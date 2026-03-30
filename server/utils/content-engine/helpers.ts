import type { ContentrainConfig } from '@contentrain/types'
import type { EngineInternalContext } from './types'
import { CONTENT_BRANCH } from './types'

/**
 * Generate a v2 branch name following git-architecture.md §2.3:
 * cr/{scope}/{target}[/{locale}]/{timestamp}-{suffix}
 */
export function generateBranchName(scope: string, target: string, locale?: string): string {
  const timestamp = Math.floor(Date.now() / 1000)
  const suffix = Array.from(crypto.getRandomValues(new Uint8Array(2)))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
  const parts = ['cr', scope, target]
  if (locale) parts.push(locale)
  parts.push(`${timestamp}-${suffix}`)
  return parts.join('/')
}

/**
 * Normalize content data to object-map format.
 * Contentrain MCP stores collections as arrays: [{id: "abc", ...}, ...]
 * Studio uses object-maps: { "abc": { ... } }
 * This function converts arrays to object-maps for consistent handling.
 */
export function toObjectMap(data: unknown): Record<string, unknown> {
  if (Array.isArray(data)) {
    const map: Record<string, unknown> = {}
    for (let i = 0; i < data.length; i++) {
      const entry = data[i]
      if (typeof entry === 'object' && entry !== null) {
        const id = (entry as Record<string, unknown>).id
          ?? (entry as Record<string, unknown>).ID
          ?? `entry-${i}`
        const { id: _id, ID: _ID, ...fields } = entry as Record<string, unknown>
        map[String(id)] = fields
      }
    }
    return map
  }
  if (typeof data === 'object' && data !== null) {
    return data as Record<string, unknown>
  }
  return {}
}

/**
 * Build updated context.json content for a write operation.
 * Reads existing context, merges with new operation data.
 */
export async function buildContextUpdate(
  ctx: EngineInternalContext,
  contextPath: string,
  operation: { tool: string, model: string, locale: string, entries?: string[] },
  modelCount: number,
  locales: string[],
  ref?: string,
): Promise<string> {
  let existing: Record<string, unknown> = {}
  try {
    existing = JSON.parse(await ctx.git.readFile(contextPath, ref)) as Record<string, unknown>
  }
  catch { /* no existing context */ }

  const now = new Date().toISOString()
  const existingStats = existing.stats as { entries?: number } | undefined

  const updated = {
    version: '1',
    lastOperation: {
      tool: operation.tool,
      model: operation.model,
      locale: operation.locale,
      entries: operation.entries,
      timestamp: now,
      source: 'mcp-studio',
    },
    stats: {
      models: modelCount,
      entries: existingStats?.entries ?? 0,
      locales,
      lastSync: now,
    },
  }

  return serializeCanonical(updated)
}

/**
 * Helper: get current model count + supported locales for context.json.
 * Used by ensureContentBranch setup and exposed via EngineInternalContext.
 */
export async function getProjectInfo(
  ctx: EngineInternalContext,
  fallbackLocale: string,
): Promise<{ modelCount: number, locales: string[] }> {
  let modelCount = 0
  try {
    const files = await ctx.git.listDirectory(resolveModelsDir(ctx.pathCtx), CONTENT_BRANCH)
    modelCount = files.filter(f => f.endsWith('.json')).length
  }
  catch { /* no models dir */ }

  let locales = [fallbackLocale]
  try {
    const cfg = JSON.parse(await ctx.git.readFile(resolveConfigPath(ctx.pathCtx), CONTENT_BRANCH)) as ContentrainConfig
    locales = cfg.locales?.supported ?? [fallbackLocale]
  }
  catch { /* no config */ }

  return { modelCount, locales }
}

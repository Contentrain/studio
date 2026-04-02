import type { ContentrainConfig } from '@contentrain/types'
import type { EngineInternalContext } from './types'
import { CONTENT_BRANCH } from './types'
import { checkBranchHealth, getHealthStatus } from '../branch-health'

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
 * Create a cr/* feature branch with branch health enforcement.
 *
 * Checks cached health status (or fetches fresh if stale) and blocks
 * new branch creation when 80+ unmerged branches exist (git-architecture.md §8.2).
 * Returns a warning message when 50+ unmerged branches exist.
 */
export async function createFeatureBranch(
  ctx: EngineInternalContext,
  scope: string,
  target: string,
  locale?: string,
): Promise<{ branchName: string, healthWarning?: string }> {
  // Check branch health before creating a new branch
  if (ctx.projectId) {
    const cached = await getHealthStatus(ctx.projectId)
    const health = cached ?? await checkBranchHealth(ctx.git, ctx.projectId)

    if (health.status === 'blocked') {
      throw createError({
        statusCode: 429,
        message: errorMessage('branches.health_blocked'),
      })
    }

    const branchName = generateBranchName(scope, target, locale)
    await ctx.git.createBranch(branchName, CONTENT_BRANCH)

    return {
      branchName,
      healthWarning: health.status === 'warning'
        ? `Warning: ${health.unmergedCount} unmerged branches. Review and merge pending branches.`
        : undefined,
    }
  }

  // No projectId — skip health check (backward compatibility)
  const branchName = generateBranchName(scope, target, locale)
  await ctx.git.createBranch(branchName, CONTENT_BRANCH)
  return { branchName }
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

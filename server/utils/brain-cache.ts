/**
 * Server-side Content Brain cache.
 *
 * In-memory per-project content cache. Replaces repeated Git reads across
 * snapshot.get, content/[modelId].get, and chat.post system prompt building.
 *
 * Uses Git Tree API for delta detection:
 * - getTree() returns all file paths + SHA hashes in one call
 * - If tree hash unchanged → cache is valid (0 additional Git calls)
 * - If tree hash changed → rebuild from Git (N calls, then cached)
 *
 * Cache is module-scoped (survives across requests, cleared on redeploy).
 * Self-hosted product = single Node.js process = no distributed cache needed.
 */

import type { ContentrainConfig, ModelDefinition, ModelKind } from '@contentrain/types'
import type { GitProvider, TreeEntry } from '../providers/git'
import matter from 'gray-matter'

export interface BrainCacheEntry {
  treeSha: string
  config: ContentrainConfig | null
  models: Map<string, ModelDefinition>
  /** Content data keyed by `${modelId}:${locale}` */
  content: Map<string, unknown>
  /** Meta data keyed by `${modelId}:${locale}` */
  meta: Map<string, Record<string, unknown>>
  vocabulary: Record<string, Record<string, string>> | null
  contentContext: Record<string, unknown> | null
  /** Content summary per model (entry count + locales) */
  contentSummary: Record<string, { count: number, locales: string[], kind: ModelKind }>
  lastRefresh: number
  projectId: string
}

const brainCache = new Map<string, BrainCacheEntry>()
const BRAIN_TTL_MS = 10 * 60 * 1000 // 10 minutes safety net
const MAX_CACHE_ENTRIES = 100

/**
 * Get cached brain entry if valid.
 */
export function getBrainCache(projectId: string): BrainCacheEntry | null {
  return brainCache.get(projectId) ?? null
}

/**
 * Check if cache is stale (TTL expired).
 */
export function isBrainStale(projectId: string): boolean {
  const entry = brainCache.get(projectId)
  if (!entry) return true
  return Date.now() - entry.lastRefresh > BRAIN_TTL_MS
}

/**
 * Invalidate cache for a project. Next access triggers rebuild.
 */
export function invalidateBrainCache(projectId: string): void {
  brainCache.delete(projectId)
}

/**
 * Compute a simple hash from tree entries for delta detection.
 */
function computeTreeHash(tree: TreeEntry[]): string {
  // Use the concatenation of all content-related file SHAs
  const contentFiles = tree
    .filter(e => e.type === 'blob' && (e.path.includes('.contentrain/') || e.path.endsWith('.md') || e.path.endsWith('.json')))
    .sort((a, b) => a.path.localeCompare(b.path))
  return contentFiles.map(e => `${e.path}:${e.sha}`).join('|')
}

/**
 * Get brain cache, building from Git if needed.
 * Optimized: checks tree SHA first (1 Git call), only rebuilds if changed.
 */
export async function getOrBuildBrainCache(
  git: GitProvider,
  contentRoot: string,
  projectId: string,
): Promise<BrainCacheEntry> {
  const cached = brainCache.get(projectId)

  if (cached && !isBrainStale(projectId)) {
    // Quick SHA check via tree
    try {
      const tree = await git.getTree()
      const currentHash = computeTreeHash(tree)
      if (cached.treeSha === currentHash) {
        return cached
      }
      // Tree changed — rebuild
    }
    catch {
      // Git error — use stale cache rather than fail
      return cached
    }
  }

  // Build fresh
  const entry = await buildBrainSnapshot(git, contentRoot, projectId)
  setBrainCache(projectId, entry)
  return entry
}

function setBrainCache(projectId: string, entry: BrainCacheEntry): void {
  // Evict oldest if at capacity
  if (brainCache.size >= MAX_CACHE_ENTRIES) {
    let oldestKey: string | null = null
    let oldestTime = Infinity
    for (const [key, val] of brainCache) {
      if (val.lastRefresh < oldestTime) {
        oldestTime = val.lastRefresh
        oldestKey = key
      }
    }
    if (oldestKey) brainCache.delete(oldestKey)
  }
  brainCache.set(projectId, entry)
}

/**
 * Build a complete brain snapshot from Git.
 * Reads config, all models, all content, all meta, vocabulary, context.
 */
export async function buildBrainSnapshot(
  git: GitProvider,
  contentRoot: string,
  projectId: string,
): Promise<BrainCacheEntry> {
  const ctx = { contentRoot }

  // 1. Get tree for SHA tracking
  let tree: TreeEntry[] = []
  try {
    tree = await git.getTree()
  }
  catch { /* empty repo or no access */ }

  const treeSha = computeTreeHash(tree)

  // 2. Read config
  let config: ContentrainConfig | null = null
  try {
    config = JSON.parse(await git.readFile(resolveConfigPath(ctx))) as ContentrainConfig
  }
  catch { /* no config */ }

  if (!config) {
    return {
      treeSha,
      config: null,
      models: new Map(),
      content: new Map(),
      meta: new Map(),
      vocabulary: null,
      contentContext: null,
      contentSummary: {},
      lastRefresh: Date.now(),
      projectId,
    }
  }

  const defaultLocale = config.locales?.default ?? 'en'
  const supportedLocales = config.locales?.supported ?? [defaultLocale]

  // 3. Read all model definitions
  const models = new Map<string, ModelDefinition>()
  try {
    const modelFiles = await git.listDirectory(resolveModelsDir(ctx))
    const modelReads = modelFiles
      .filter(f => f.endsWith('.json'))
      .map(async (file) => {
        try {
          const def = JSON.parse(await git.readFile(`${resolveModelsDir(ctx)}/${file}`)) as ModelDefinition
          models.set(def.id ?? file.replace('.json', ''), def)
        }
        catch { /* skip invalid model */ }
      })
    await Promise.all(modelReads)
  }
  catch { /* no models directory */ }

  // 4. Read all content + meta for each model
  const content = new Map<string, unknown>()
  const metaMap = new Map<string, Record<string, unknown>>()
  const contentSummary: Record<string, { count: number, locales: string[], kind: ModelKind }> = {}

  const contentReads: Promise<void>[] = []

  for (const [modelId, model] of models) {
    const kind = model.kind ?? 'collection'
    const locales = model.i18n ? supportedLocales : ['data']
    const modelLocales: string[] = []

    for (const locale of locales) {
      contentReads.push((async () => {
        const key = `${modelId}:${locale === 'data' ? defaultLocale : locale}`

        if (kind === 'document') {
          // Document kind: list slugs, parse markdown
          try {
            const contentDir = model.content_path
              ? (contentRoot ? `${contentRoot}/${model.content_path}` : model.content_path)
              : `${contentRoot ? `${contentRoot}/` : ''}.contentrain/content/${model.domain}/${model.id}`

            const items = await git.listDirectory(contentDir)
            const entries: Array<Record<string, unknown>> = []

            for (const item of items) {
              try {
                let slug: string
                let mdPath: string

                if (model.i18n) {
                  slug = item
                  mdPath = `${contentDir}/${slug}/${locale}.md`
                }
                else {
                  if (!item.endsWith('.md')) continue
                  slug = item.replace(/\.md$/, '')
                  mdPath = `${contentDir}/${item}`
                }

                const raw = await git.readFile(mdPath)
                const parsed = matter(raw)

                // Read per-document meta
                let entryMeta: Record<string, unknown> | null = null
                try {
                  const metaPath = resolveMetaPath(ctx, model, locale === 'data' ? defaultLocale : locale, slug)
                  entryMeta = JSON.parse(await git.readFile(metaPath)) as Record<string, unknown>
                }
                catch { /* no meta */ }

                entries.push({
                  slug,
                  frontmatter: parsed.data,
                  body: parsed.content,
                  meta: entryMeta,
                })
              }
              catch { /* skip invalid document */ }
            }

            content.set(key, entries)
            modelLocales.push(locale === 'data' ? defaultLocale : locale)
          }
          catch { /* directory not accessible */ }
        }
        else {
          // JSON kinds: collection, singleton, dictionary
          try {
            const contentPath = resolveContentPath(ctx, model, locale)
            const raw = await git.readFile(contentPath)
            content.set(key, JSON.parse(raw))
            modelLocales.push(locale === 'data' ? defaultLocale : locale)
          }
          catch { /* content file not found */ }

          // Meta
          try {
            const metaPath = resolveMetaPath(ctx, model, locale === 'data' ? defaultLocale : locale)
            metaMap.set(key, JSON.parse(await git.readFile(metaPath)) as Record<string, unknown>)
          }
          catch { /* no meta */ }
        }
      })())
    }

    // Content summary will be computed after all reads
    contentReads.push((async () => {
      // Wait for this model's content to be populated
      await Promise.resolve() // yield
      let entryCount = 0
      for (const [k, v] of content) {
        if (!k.startsWith(`${modelId}:`)) continue
        if (kind === 'collection' && typeof v === 'object' && v !== null && !Array.isArray(v)) {
          entryCount = Math.max(entryCount, Object.keys(v).length)
        }
        else if (Array.isArray(v)) {
          entryCount = Math.max(entryCount, v.length)
        }
        else if (v !== null) {
          entryCount = 1
        }
      }
      contentSummary[modelId] = { count: entryCount, locales: modelLocales, kind }
    })())
  }

  await Promise.all(contentReads)

  // 5. Read vocabulary
  let vocabulary: Record<string, Record<string, string>> | null = null
  try {
    const vocabData = JSON.parse(await git.readFile(resolveVocabularyPath(ctx))) as { terms?: Record<string, Record<string, string>> }
    vocabulary = vocabData.terms ?? null
  }
  catch { /* no vocabulary */ }

  // 6. Read context.json
  let contentContext: Record<string, unknown> | null = null
  try {
    contentContext = JSON.parse(await git.readFile(resolveContextPath(ctx))) as Record<string, unknown>
  }
  catch { /* no context */ }

  return {
    treeSha,
    config,
    models,
    content,
    meta: metaMap,
    vocabulary,
    contentContext,
    contentSummary,
    lastRefresh: Date.now(),
    projectId,
  }
}

/**
 * Build a compact content index for agent system prompt.
 * ~200-500 tokens instead of ~3000 tokens for raw schemas.
 */
export function buildContentIndex(brain: BrainCacheEntry): string {
  if (!brain.config) return ''

  const lines: string[] = ['## Content Index']
  const totalEntries = Object.values(brain.contentSummary).reduce((sum, s) => sum + s.count, 0)
  const allLocales = new Set<string>()
  for (const s of Object.values(brain.contentSummary)) {
    for (const l of s.locales) allLocales.add(l)
  }

  lines.push(`${totalEntries} entries across ${brain.models.size} models, locales: [${[...allLocales].join(', ')}]`)
  lines.push('')

  for (const [modelId, model] of brain.models) {
    const summary = brain.contentSummary[modelId]
    if (!summary) continue

    const parts = [`${model.name} (${modelId}): ${summary.kind}, ${summary.count} entries`]
    if (summary.locales.length > 0) parts.push(`locales: [${summary.locales.join(', ')}]`)

    // Quick health checks
    const key = `${modelId}:${summary.locales[0] ?? 'en'}`
    const contentData = brain.content.get(key)
    const metaData = brain.meta.get(key)

    if (contentData && typeof contentData === 'object' && !Array.isArray(contentData) && metaData) {
      const entries = Object.keys(contentData)
      const meta = metaData as Record<string, { status?: string }>
      const published = entries.filter(id => meta[id]?.status === 'published').length
      const draft = entries.filter(id => meta[id]?.status === 'draft').length
      if (published > 0 || draft > 0) {
        parts.push(`published: ${published}, draft: ${draft}`)
      }
    }

    lines.push(`- ${parts.join(' | ')}`)
  }

  lines.push('')
  lines.push('Use brain_query to read full content, brain_search to find entries by keyword.')

  return lines.join('\n')
}

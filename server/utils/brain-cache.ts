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
import type { SchemaValidationResult } from './schema-validation'
import matter from 'gray-matter'

/** SSOT content branch — read from this for latest content state */
const CONTENT_REF = 'contentrain'

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
  /** Schema validation results (computed on build) */
  schemaValidation: SchemaValidationResult | null
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
  // Only track .contentrain/ files — not the entire repo
  const contentFiles = tree
    .filter(e => e.type === 'blob' && e.path.includes('.contentrain/'))
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
      const tree = await git.getTree(CONTENT_REF).catch(() => git.getTree())
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

  // Build fresh (pass previous brain for breaking change detection)
  const previousBrain = cached ?? null
  const entry = await buildBrainSnapshot(git, contentRoot, projectId, previousBrain)
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
  previousBrain?: BrainCacheEntry | null,
): Promise<BrainCacheEntry> {
  const ctx = { contentRoot }

  // 1. Get tree for SHA tracking
  // Read from contentrain branch (SSOT) if available, else default
  let contentRef: string | undefined = CONTENT_REF
  let tree: TreeEntry[] = []
  try {
    tree = await git.getTree(contentRef)
  }
  catch {
    contentRef = undefined
    try {
      tree = await git.getTree()
    }
    catch { /* empty repo or no access */ }
  }

  const treeSha = computeTreeHash(tree)

  // 2. Read config
  let config: ContentrainConfig | null = null
  try {
    config = JSON.parse(await git.readFile(resolveConfigPath(ctx), contentRef)) as ContentrainConfig
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
      schemaValidation: null,
      lastRefresh: Date.now(),
      projectId,
    }
  }

  const defaultLocale = config.locales?.default ?? 'en'
  const supportedLocales = config.locales?.supported ?? [defaultLocale]

  // 3. Read all model definitions
  const models = new Map<string, ModelDefinition>()
  try {
    const modelsDir = resolveModelsDir(ctx)
    // eslint-disable-next-line no-console
    console.log(`[brain] Reading models from: ${modelsDir}`)
    const modelFiles = await git.listDirectory(modelsDir, contentRef)
    // eslint-disable-next-line no-console
    console.log(`[brain] Found ${modelFiles.length} model files:`, modelFiles)
    const modelReads = modelFiles
      .filter(f => f.endsWith('.json'))
      .map(async (file) => {
        try {
          const raw = JSON.parse(await git.readFile(`${modelsDir}/${file}`, contentRef)) as Record<string, unknown>
          const modelId = (raw.id as string) ?? file.replace('.json', '')
          // Ensure id and name are always set (some model files omit them)
          const def = {
            ...raw,
            id: modelId,
            name: (raw.name as string) ?? modelId,
            kind: (raw.kind as string) ?? 'collection',
          } as ModelDefinition
          models.set(modelId, def)
        }
        catch (e) {
          // eslint-disable-next-line no-console
          console.error(`[brain] Failed to read model ${file}:`, e)
        }
      })
    await Promise.all(modelReads)
    // eslint-disable-next-line no-console
    console.log(`[brain] Loaded ${models.size} models`)
  }
  catch (e) {
    // eslint-disable-next-line no-console
    console.error(`[brain] Failed to list models directory:`, e)
  }

  // 4. Read all content + meta for each model
  const content = new Map<string, unknown>()
  const metaMap = new Map<string, Record<string, unknown>>()
  const contentSummary: Record<string, { count: number, locales: string[], kind: ModelKind }> = {}

  const contentReads: Promise<void>[] = []

  for (const [modelId, model] of models) {
    const kind = (model.kind ?? 'collection') as string
    const locales = model.i18n ? supportedLocales : ['data']
    // eslint-disable-next-line no-console
    console.log(`[brain] Reading content for model ${modelId} (${kind}, i18n: ${model.i18n}, locales: ${locales.join(',')})`)

    for (const locale of locales) {
      contentReads.push((async () => {
        const key = `${modelId}:${locale === 'data' ? defaultLocale : locale}`

        if (kind === 'document') {
          // Document kind: list slugs, parse markdown
          try {
            const contentDir = model.content_path
              ? (contentRoot ? `${contentRoot}/${model.content_path}` : model.content_path)
              : `${contentRoot ? `${contentRoot}/` : ''}.contentrain/content/${model.domain}/${model.id}`

            const items = await git.listDirectory(contentDir, contentRef)
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

                const raw = await git.readFile(mdPath, contentRef)
                const parsed = matter(raw)

                // Read per-document meta
                let entryMeta: Record<string, unknown> | null = null
                try {
                  const metaPath = resolveMetaPath(ctx, model, locale === 'data' ? defaultLocale : locale, slug)
                  entryMeta = JSON.parse(await git.readFile(metaPath, contentRef)) as Record<string, unknown>
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
            // locale tracked in summary post-processing
          }
          catch { /* directory not accessible */ }
        }
        else {
          // JSON kinds: collection, singleton, dictionary
          try {
            const contentPath = resolveContentPath(ctx, model, locale)
            // eslint-disable-next-line no-console
            console.log(`[brain] Reading content: ${contentPath}`)
            const raw = await git.readFile(contentPath, contentRef)
            content.set(key, JSON.parse(raw))
            // locale tracked in summary post-processing
            // eslint-disable-next-line no-console
            console.log(`[brain] ✓ Content loaded for ${key}`)
          }
          catch (e) {
            // eslint-disable-next-line no-console
            console.error(`[brain] ✗ Content failed for ${modelId}:${locale}:`, (e as Error).message?.substring(0, 100))
          }

          // Meta
          try {
            const metaPath = resolveMetaPath(ctx, model, locale === 'data' ? defaultLocale : locale)
            metaMap.set(key, JSON.parse(await git.readFile(metaPath, contentRef)) as Record<string, unknown>)
          }
          catch { /* no meta */ }
        }
      })())
    }

    // Content summary computed after Promise.all below (not here — race condition)
    // Summary computed after Promise.all(contentReads) below
  }

  await Promise.all(contentReads)

  // 4.5 Compute content summaries (after all reads complete — no race condition)
  for (const [modelId, model] of models) {
    const kind = (model.kind ?? 'collection') as ModelKind
    let entryCount = 0
    const localesFound: string[] = []

    for (const [k, v] of content) {
      if (!k.startsWith(`${modelId}:`)) continue
      const locale = k.split(':')[1] ?? defaultLocale
      localesFound.push(locale)
      if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
        entryCount = Math.max(entryCount, Object.keys(v).length)
      }
      else if (Array.isArray(v)) {
        entryCount = Math.max(entryCount, v.length)
      }
      else if (v !== null) {
        entryCount = 1
      }
    }
    contentSummary[modelId] = { count: entryCount, locales: localesFound, kind }
  }

  // eslint-disable-next-line no-console
  console.log(`[brain] Content summary:`, Object.entries(contentSummary).map(([id, s]) => `${id}: ${s.count} entries (${s.locales.join(',')})`).join(', '))

  // 5. Read vocabulary
  let vocabulary: Record<string, Record<string, string>> | null = null
  try {
    const vocabData = JSON.parse(await git.readFile(resolveVocabularyPath(ctx), contentRef)) as { terms?: Record<string, Record<string, string>> }
    vocabulary = vocabData.terms ?? null
  }
  catch { /* no vocabulary */ }

  // 6. Read context.json
  let contentContext: Record<string, unknown> | null = null
  try {
    contentContext = JSON.parse(await git.readFile(resolveContextPath(ctx), contentRef)) as Record<string, unknown>
  }
  catch { /* no context */ }

  const brain: BrainCacheEntry = {
    treeSha,
    config,
    models,
    content,
    meta: metaMap,
    vocabulary,
    contentContext,
    contentSummary,
    schemaValidation: null,
    lastRefresh: Date.now(),
    projectId,
  }

  // 7. Run schema validation (synchronous, pure — no I/O)
  try {
    const { validateProjectSchema } = await import('./schema-validation')
    brain.schemaValidation = validateProjectSchema(brain, previousBrain)
  }
  catch { /* validation failure shouldn't block brain build */ }

  return brain
}

/**
 * Build a rich content index for agent system prompt.
 * Gives the agent full project awareness: entry details, health issues,
 * locale parity, stale content — all in ~300-800 tokens.
 */
export function buildContentIndex(brain: BrainCacheEntry): string {
  if (!brain.config) return ''

  const config = brain.config
  const defaultLocale = config.locales?.default ?? 'en'
  const supportedLocales = config.locales?.supported ?? [defaultLocale]

  const lines: string[] = ['## Content Index']
  const totalEntries = Object.values(brain.contentSummary).reduce((sum, s) => sum + s.count, 0)

  lines.push(`${totalEntries} entries, ${brain.models.size} models, locales: [${supportedLocales.join(', ')}]`)
  lines.push('')

  const healthIssues: string[] = []
  const now = Date.now()
  const STALE_DAYS = 90
  const staleThreshold = now - (STALE_DAYS * 24 * 60 * 60 * 1000)

  for (const [modelId, model] of brain.models) {
    const summary = brain.contentSummary[modelId]
    if (!summary) continue

    const modelLine = [`${model.name} (${modelId}): ${summary.kind}, ${summary.count} entries`]

    // Primary locale content analysis
    const primaryKey = `${modelId}:${summary.locales[0] ?? defaultLocale}`
    const contentData = brain.content.get(primaryKey)
    const metaData = brain.meta.get(primaryKey)
    const fields = model.fields as Record<string, { type?: string, required?: boolean }> | undefined

    if (contentData && typeof contentData === 'object' && !Array.isArray(contentData)) {
      const entries = Object.entries(contentData as Record<string, Record<string, unknown>>)
      const meta = (metaData ?? {}) as Record<string, { status?: string, updated_at?: string }>

      // Status counts
      let published = 0
      let draft = 0
      for (const [id] of entries) {
        const status = meta[id]?.status
        if (status === 'published') published++
        else draft++
      }
      if (published > 0 || draft > 0) {
        modelLine.push(`published: ${published}, draft: ${draft}`)
      }

      // Missing required fields
      if (fields) {
        const requiredFields = Object.entries(fields).filter(([_, f]) => f.required).map(([k]) => k)
        for (const fieldId of requiredFields) {
          const missing = entries.filter(([_, e]) => !e[fieldId] || e[fieldId] === '').length
          if (missing > 0) {
            healthIssues.push(`${model.name}: ${missing} entries missing required "${fieldId}"`)
          }
        }

        // Missing meta_description (SEO check)
        if (fields.meta_description || fields.description || fields.seo_description) {
          const descField = fields.meta_description ? 'meta_description' : fields.description ? 'description' : 'seo_description'
          const missingDesc = entries.filter(([_, e]) => !e[descField] || e[descField] === '').length
          if (missingDesc > 0) {
            healthIssues.push(`${model.name}: ${missingDesc} entries missing "${descField}" (SEO)`)
          }
        }

        // Missing alt text on image fields
        const imageFields = Object.entries(fields).filter(([_, f]) => f.type === 'image').map(([k]) => k)
        for (const imgField of imageFields) {
          const missingAlt = entries.filter(([_, e]) => e[imgField] && !e[`${imgField}_alt`] && !e.alt).length
          if (missingAlt > 0 && missingAlt < entries.length) {
            healthIssues.push(`${model.name}: ${missingAlt} entries with image but no alt text`)
          }
        }
      }

      // Stale entries (90+ days)
      let staleCount = 0
      for (const [id] of entries) {
        const updatedAt = meta[id]?.updated_at
        if (updatedAt && new Date(updatedAt).getTime() < staleThreshold) {
          staleCount++
        }
      }
      if (staleCount > 0) {
        healthIssues.push(`${model.name}: ${staleCount} stale entries (${STALE_DAYS}+ days)`)
      }

      // Entry titles preview (first 5)
      const primaryField = fields ? findPrimaryField(fields) : null
      if (primaryField && entries.length > 0) {
        const titles = entries.slice(0, 5).map(([_, e]) => String(e[primaryField] ?? '').substring(0, 50)).filter(Boolean)
        if (titles.length > 0) {
          modelLine.push(`recent: ${titles.map(t => `"${t}"`).join(', ')}${entries.length > 5 ? ` +${entries.length - 5} more` : ''}`)
        }
      }
    }
    else if (Array.isArray(contentData)) {
      // Document kind
      modelLine.push(`${contentData.length} documents`)
      const slugs = contentData.slice(0, 5).map((d: unknown) => (d as Record<string, unknown>)?.slug).filter(Boolean)
      if (slugs.length > 0) {
        modelLine.push(`slugs: ${slugs.map(s => `"${s}"`).join(', ')}${contentData.length > 5 ? ` +${contentData.length - 5} more` : ''}`)
      }
    }

    // Locale parity check
    if (supportedLocales.length > 1 && model.i18n) {
      const localeCounts: Record<string, number> = {}
      for (const locale of supportedLocales) {
        const locKey = `${modelId}:${locale}`
        const locData = brain.content.get(locKey)
        if (locData && typeof locData === 'object' && !Array.isArray(locData)) {
          localeCounts[locale] = Object.keys(locData).length
        }
        else if (Array.isArray(locData)) {
          localeCounts[locale] = locData.length
        }
        else {
          localeCounts[locale] = 0
        }
      }
      const counts = Object.values(localeCounts)
      const maxCount = Math.max(...counts)
      const missingLocales = Object.entries(localeCounts).filter(([_, c]) => c < maxCount)
      if (missingLocales.length > 0 && maxCount > 0) {
        const gaps = missingLocales.map(([l, c]) => `${l}: ${c}/${maxCount}`).join(', ')
        healthIssues.push(`${model.name}: locale gap — ${gaps}`)
      }
    }

    lines.push(`- ${modelLine.join(' | ')}`)
  }

  // Health summary
  if (healthIssues.length > 0) {
    lines.push('')
    lines.push('### Content Health Issues')
    for (const issue of healthIssues.slice(0, 10)) {
      lines.push(`⚠ ${issue}`)
    }
    if (healthIssues.length > 10) {
      lines.push(`... and ${healthIssues.length - 10} more issues`)
    }
  }

  // Schema validation summary
  if (brain.schemaValidation) {
    const sv = brain.schemaValidation
    const criticals = sv.warnings.filter(w => w.severity === 'critical')
    const errors = sv.warnings.filter(w => w.severity === 'error')
    if (criticals.length > 0 || errors.length > 0) {
      lines.push('')
      lines.push(`### Schema Health: ${sv.healthScore}/100`)
      for (const w of [...criticals, ...errors].slice(0, 5)) {
        const prefix = w.severity === 'critical' ? '🔴' : '🟠'
        lines.push(`${prefix} ${w.modelId}${w.field ? `.${w.field}` : ''}: ${w.message}`)
      }
      const remaining = criticals.length + errors.length - 5
      if (remaining > 0) {
        lines.push(`... and ${remaining} more schema issues`)
      }
      lines.push('Use validate_schema for full report.')
    }
  }

  lines.push('')
  lines.push('Use brain_query to read content, brain_search to find entries, brain_analyze for detailed audits.')

  return lines.join('\n')
}

/**
 * Find the primary display field for a model (title, name, label, slug).
 */
function findPrimaryField(fields: Record<string, { type?: string, required?: boolean }>): string | null {
  // Priority: title → name → label → slug → first required string
  for (const candidate of ['title', 'name', 'label', 'heading', 'question']) {
    if (fields[candidate]) return candidate
  }
  for (const [key, def] of Object.entries(fields)) {
    if (def.required && (def.type === 'string' || def.type === 'slug')) return key
  }
  for (const [key, def] of Object.entries(fields)) {
    if (def.type === 'string' || def.type === 'slug') return key
  }
  return null
}

/**
 * Run content analysis for brain_analyze tool.
 * Pre-built aggregate queries against brain cache.
 */
export function analyzeBrainContent(
  brain: BrainCacheEntry,
  analysisType: 'seo_audit' | 'locale_parity' | 'stale_content' | 'quality_score' | 'full',
): Record<string, unknown> {
  const config = brain.config
  if (!config) return { error: agentMessage('analyze.not_initialized') }

  const defaultLocale = config.locales?.default ?? 'en'
  const supportedLocales = config.locales?.supported ?? [defaultLocale]
  const now = Date.now()

  const result: Record<string, unknown> = { analysisType, timestamp: new Date().toISOString() }

  // SEO Audit
  if (analysisType === 'seo_audit' || analysisType === 'full') {
    const seoIssues: Array<{ model: string, entryId: string, issue: string }> = []

    for (const [modelId, model] of brain.models) {
      const fields = model.fields as Record<string, { type?: string }> | undefined
      if (!fields) continue

      const descField = fields.meta_description ? 'meta_description' : fields.description ? 'description' : fields.seo_description ? 'seo_description' : null
      const titleField = findPrimaryField(fields as Record<string, { type?: string, required?: boolean }>)

      const primaryKey = `${modelId}:${brain.contentSummary[modelId]?.locales[0] ?? defaultLocale}`
      const contentData = brain.content.get(primaryKey)
      if (!contentData || typeof contentData !== 'object' || Array.isArray(contentData)) continue

      for (const [entryId, entry] of Object.entries(contentData as Record<string, Record<string, unknown>>)) {
        if (descField && (!entry[descField] || String(entry[descField]).length === 0)) {
          seoIssues.push({ model: model.name, entryId, issue: agentMessage('analyze.seo_missing_field', { field: descField }) })
        }
        if (titleField) {
          const title = String(entry[titleField] ?? '')
          if (title.length > 60) {
            seoIssues.push({ model: model.name, entryId, issue: agentMessage('analyze.seo_title_long', { length: title.length, max: 60 }) })
          }
          if (title.length < 10 && title.length > 0) {
            seoIssues.push({ model: model.name, entryId, issue: agentMessage('analyze.seo_title_short', { length: title.length, min: 10 }) })
          }
        }
      }
    }
    result.seo = { issues: seoIssues, total: seoIssues.length }
  }

  // Locale Parity
  if (analysisType === 'locale_parity' || analysisType === 'full') {
    const parityIssues: Array<{ model: string, locale: string, count: number, expected: number }> = []

    for (const [modelId, model] of brain.models) {
      if (!model.i18n || supportedLocales.length < 2) continue

      const counts: Record<string, number> = {}
      for (const locale of supportedLocales) {
        const key = `${modelId}:${locale}`
        const data = brain.content.get(key)
        counts[locale] = data && typeof data === 'object' && !Array.isArray(data) ? Object.keys(data).length : Array.isArray(data) ? data.length : 0
      }

      const maxCount = Math.max(...Object.values(counts))
      for (const [locale, count] of Object.entries(counts)) {
        if (count < maxCount) {
          parityIssues.push({ model: model.name, locale, count, expected: maxCount })
        }
      }
    }
    result.localeParity = { issues: parityIssues, total: parityIssues.length }
  }

  // Stale Content
  if (analysisType === 'stale_content' || analysisType === 'full') {
    const staleEntries: Array<{ model: string, entryId: string, daysSinceUpdate: number }> = []

    for (const [modelId, model] of brain.models) {
      const primaryKey = `${modelId}:${brain.contentSummary[modelId]?.locales[0] ?? defaultLocale}`
      const metaData = brain.meta.get(primaryKey)
      if (!metaData) continue

      for (const [entryId, meta] of Object.entries(metaData as Record<string, { updated_at?: string }>)) {
        if (meta.updated_at) {
          const updatedAt = new Date(meta.updated_at).getTime()
          const daysSince = Math.floor((now - updatedAt) / (24 * 60 * 60 * 1000))
          if (daysSince > 90) {
            staleEntries.push({ model: model.name, entryId, daysSinceUpdate: daysSince })
          }
        }
      }
    }
    result.staleContent = { entries: staleEntries.sort((a, b) => b.daysSinceUpdate - a.daysSinceUpdate), total: staleEntries.length }
  }

  // Quality Score
  if (analysisType === 'quality_score' || analysisType === 'full') {
    let totalScore = 0
    let modelCount = 0

    for (const [modelId, model] of brain.models) {
      let score = 100
      const primaryKey = `${modelId}:${brain.contentSummary[modelId]?.locales[0] ?? defaultLocale}`
      const contentData = brain.content.get(primaryKey)
      const metaData = brain.meta.get(primaryKey)
      const fields = model.fields as Record<string, { type?: string, required?: boolean }> | undefined

      if (!contentData || typeof contentData !== 'object') continue

      const entries = Array.isArray(contentData) ? contentData : Object.values(contentData)
      if (entries.length === 0) continue

      // Required field completeness (-10 per missing)
      if (fields) {
        const requiredFields = Object.entries(fields).filter(([_, f]) => f.required).map(([k]) => k)
        for (const entry of entries as Record<string, unknown>[]) {
          for (const field of requiredFields) {
            if (!entry[field] || entry[field] === '') score -= 2
          }
        }
      }

      // Meta completeness (-5 if no meta)
      if (!metaData) score -= 5

      // Locale coverage (-10 per missing locale)
      if (model.i18n && (brain.config?.locales?.supported?.length ?? 1) > 1) {
        const expectedLocales = brain.config?.locales?.supported?.length ?? 1
        const actualLocales = brain.contentSummary[modelId]?.locales.length ?? 0
        score -= (expectedLocales - actualLocales) * 10
      }

      score = Math.max(0, Math.min(100, score))
      totalScore += score
      modelCount++
    }

    const avgScore = modelCount > 0 ? Math.round(totalScore / modelCount) : 0
    const tier = avgScore >= 90 ? agentMessage('analyze.quality_excellent') : avgScore >= 75 ? agentMessage('analyze.quality_good') : avgScore >= 50 ? agentMessage('analyze.quality_fair') : agentMessage('analyze.quality_poor')
    result.quality = { score: avgScore, tier, modelCount }
  }

  return result
}

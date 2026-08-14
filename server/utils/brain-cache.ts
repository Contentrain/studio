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

import type { ContentrainConfig, FieldDef, ModelDefinition, ModelKind } from '@contentrain/types'
import type { GitProvider, TreeEntry } from '../providers/git'
import type { SchemaValidationResult } from './schema-validation'
import { createHash } from 'node:crypto'
import matter from 'gray-matter'

/** SSOT content branch — read from this for latest content state */
const CONTENT_REF = 'contentrain'

export interface BrainCacheEntry {
  treeSha: string
  /**
   * Per-path blob SHA of every tracked file (same file set `treeSha`
   * hashes over). Basis for the SHA-diff incremental refresh: after an
   * invalidation, only paths whose blob SHA changed are re-read.
   */
  fileShas: Map<string, string>
  /**
   * Set by `invalidateBrainCache`. A stale entry is refreshed
   * incrementally (SHA diff → re-read changed models only) on the next
   * `getOrBuildBrainCache` instead of being rebuilt from scratch.
   */
  stale: boolean
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
 * Check if cache is stale (invalidated by a write, or TTL expired).
 */
export function isBrainStale(projectId: string): boolean {
  const entry = brainCache.get(projectId)
  if (!entry) return true
  if (entry.stale) return true
  return Date.now() - entry.lastRefresh > BRAIN_TTL_MS
}

/**
 * Invalidate cache for a project. The entry is kept and marked stale so
 * the next access can refresh it incrementally (SHA diff) instead of
 * paying a full O(models × locales) rebuild.
 */
export function invalidateBrainCache(projectId: string): void {
  const entry = brainCache.get(projectId)
  if (entry) entry.stale = true
}

/**
 * Hard-drop the cached entry (next access = full rebuild). Not used by
 * production write paths — those mark stale; this exists for tests and
 * operational escape hatches.
 */
export function dropBrainCache(projectId: string): void {
  brainCache.delete(projectId)
}

/**
 * Normalize dates that gray-matter coerced out of document frontmatter.
 *
 * gray-matter parses YAML with js-yaml's DEFAULT_SCHEMA, which coerces
 * unquoted ISO-date scalars (`published_at: 2026-03-12`) into JS `Date`
 * objects. But Studio's write path (`serializeMarkdownFrontmatter`),
 * the CDN builder, and the field validators all treat `date`/`datetime`
 * fields as STRINGS. A coerced `Date` therefore trips the validator's
 * `Type mismatch: expected date, got object` — an error the user can
 * never clear, because every re-save round-trips back to a `Date` on the
 * next brain read. Convert any `Date` the parser produced back to a
 * string: `YYYY-MM-DD` for `date` fields, full ISO otherwise. Recurses
 * into nested objects/arrays so coerced dates in sub-fields are caught too.
 */
function normalizeFrontmatterDates(
  data: Record<string, unknown>,
  fields?: ModelDefinition['fields'],
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(data)) {
    out[key] = deCoerceDate(value, fields?.[key])
  }
  return out
}

function deCoerceDate(value: unknown, fieldDef?: FieldDef): unknown {
  if (value instanceof Date) {
    return fieldDef?.type === 'date'
      ? value.toISOString().slice(0, 10)
      : value.toISOString()
  }
  if (Array.isArray(value)) return value.map(item => deCoerceDate(item))
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = deCoerceDate(v)
    return out
  }
  return value
}

/**
 * Blobs the brain tracks: .contentrain/ files + any custom content_path
 * locations from models. Sorted for stable hashing.
 */
function trackedFiles(tree: TreeEntry[], extraPaths?: string[]): TreeEntry[] {
  return tree
    .filter((e) => {
      if (e.type !== 'blob') return false
      if (e.path.includes('.contentrain/')) return true
      // Include files matching custom content_path locations
      if (extraPaths) {
        return extraPaths.some(p => e.path.startsWith(p))
      }
      return false
    })
    .sort((a, b) => a.path.localeCompare(b.path))
}

/**
 * Fingerprint the tracked file set for delta detection.
 *
 * This used to return the manifest itself — every tracked path and blob SHA
 * joined by `|`. Only equality is ever asked of it, so that worked, right up
 * until the value left the process: the client stores it and sends it back as
 * `?treeSha=`, and on a real project that is ~30KB of query string. Proxies
 * answer a URL that long with **431**, so every sync after the first one
 * failed — and nothing downstream could tell that apart from "no changes".
 *
 * Hashing it keeps the equality semantics and makes the value 64 characters.
 * Nothing reads the parts: the per-path map used for incremental refresh is
 * built separately by `buildFileShaMap`.
 */
function computeTreeHash(tree: TreeEntry[], extraPaths?: string[]): string {
  const manifest = trackedFiles(tree, extraPaths).map(e => `${e.path}:${e.sha}`).join('|')
  return createHash('sha256').update(manifest).digest('hex')
}

/** Per-path blob SHA map over the same tracked file set as the hash. */
function buildFileShaMap(tree: TreeEntry[], extraPaths?: string[]): Map<string, string> {
  return new Map(trackedFiles(tree, extraPaths).map(e => [e.path, e.sha]))
}

/**
 * In-flight build/refresh dedup — parallel tool calls in one agent turn
 * previously each triggered a full rebuild after an invalidation.
 */
const inflightBuilds = new Map<string, Promise<BrainCacheEntry>>()

/**
 * Get brain cache, building from Git if needed.
 *
 * Freshness ladder (cheapest first):
 * 1. Valid entry (not stale, TTL ok): 1 `getTree` + hash compare — return
 *    on match; on mismatch, incremental refresh with the tree in hand.
 * 2. Stale entry (write invalidation, TTL ok): incremental refresh —
 *    1 `getTree` + re-read only the paths whose blob SHA changed.
 * 3. No entry / TTL expired / structural change (config, models/,
 *    unclassifiable path): full rebuild. The 10-minute TTL keeps its
 *    original meaning — a periodic guaranteed full rebuild.
 */
export async function getOrBuildBrainCache(
  git: GitProvider,
  contentRoot: string,
  projectId: string,
): Promise<BrainCacheEntry> {
  const cached = brainCache.get(projectId)
  const ttlExpired = !cached || Date.now() - cached.lastRefresh > BRAIN_TTL_MS

  if (cached && !cached.stale && !ttlExpired) {
    // Quick SHA check via tree
    try {
      const tree = await git.getTree(CONTENT_REF).catch(() => git.getTree())
      // Include custom content_path locations in hash
      const extraPaths = [...cached.models.values()]
        .filter(m => m.content_path)
        .map(m => m.content_path!)
      const currentHash = computeTreeHash(tree, extraPaths)
      if (cached.treeSha === currentHash) {
        return cached
      }
      // Tree changed underneath us — refresh incrementally with the
      // tree we already fetched.
      return await dedupedBuild(projectId, () => refreshOrRebuild(git, contentRoot, projectId, cached, tree))
    }
    catch {
      // Git error — use stale cache rather than fail
      return cached
    }
  }

  if (cached && cached.stale && !ttlExpired) {
    try {
      return await dedupedBuild(projectId, () => refreshOrRebuild(git, contentRoot, projectId, cached))
    }
    catch {
      // Git error mid-refresh — serve the stale entry rather than fail;
      // the next access retries (entry keeps its stale flag).
      return cached
    }
  }

  // Build fresh (pass previous brain for breaking change detection)
  return dedupedBuild(projectId, async () => {
    const entry = await buildBrainSnapshot(git, contentRoot, projectId, cached ?? null)
    setBrainCache(projectId, entry)
    return entry
  })
}

async function dedupedBuild(
  projectId: string,
  work: () => Promise<BrainCacheEntry>,
): Promise<BrainCacheEntry> {
  const existing = inflightBuilds.get(projectId)
  if (existing) return existing
  const promise = work().finally(() => inflightBuilds.delete(projectId))
  inflightBuilds.set(projectId, promise)
  return promise
}

async function refreshOrRebuild(
  git: GitProvider,
  contentRoot: string,
  projectId: string,
  cached: BrainCacheEntry,
  tree?: TreeEntry[],
): Promise<BrainCacheEntry> {
  const refreshed = await refreshBrainSnapshot(git, contentRoot, projectId, cached, tree)
  if (refreshed) {
    setBrainCache(projectId, refreshed)
    return refreshed
  }
  const entry = await buildBrainSnapshot(git, contentRoot, projectId, cached)
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

interface ModelBundle {
  content: Array<[string, unknown]>
  meta: Array<[string, Record<string, unknown>]>
}

/**
 * Read one model's content + meta across its locales. This is the ONLY
 * code path that parses model content into brain shape — both the full
 * `buildBrainSnapshot` and the incremental `refreshBrainSnapshot` go
 * through it, which is what guarantees an incremental patch produces
 * exactly what a full rebuild would.
 */
async function readModelBundle(
  git: GitProvider,
  ctx: { contentRoot: string },
  contentRoot: string,
  model: ModelDefinition,
  supportedLocales: string[],
  defaultLocale: string,
  contentRef: string | undefined,
): Promise<ModelBundle> {
  const kind = (model.kind ?? 'collection') as string
  const locales = model.i18n ? supportedLocales : ['data']
  const modelId = model.id
  const bundle: ModelBundle = { content: [], meta: [] }

  await Promise.all(locales.map(async (locale) => {
    const key = `${modelId}:${locale === 'data' ? defaultLocale : locale}`

    if (kind === 'document') {
      // Document kind: list slugs, parse markdown
      try {
        const contentDir = model.content_path
          ? (contentRoot ? `${contentRoot}/${model.content_path}` : model.content_path)
          : `${contentRoot ? `${contentRoot}/` : ''}.contentrain/content/${model.domain}/${model.id}`

        const items = await git.listDirectory(contentDir, contentRef)
        const entries: Array<Record<string, unknown>> = []
        // Document meta lives per-slug (`.../meta/{modelId}/{slug}/{locale}.json`).
        // Collapse it into one slug-keyed map so the brain/UI read document
        // status exactly like a collection's id-keyed meta map (`meta[slug].status`).
        // Previously each entry carried its own `meta` and `bundle.meta` stayed
        // empty for documents, so the status never reached the content panel.
        const metaBySlug: Record<string, unknown> = {}

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

            // Read this slug's meta into the shared slug-keyed map.
            try {
              const metaPath = resolveMetaPath(ctx, model, locale, defaultLocale, slug)
              metaBySlug[slug] = JSON.parse(await git.readFile(metaPath, contentRef)) as Record<string, unknown>
            }
            catch { /* no meta for this slug */ }

            entries.push({
              slug,
              frontmatter: normalizeFrontmatterDates(parsed.data as Record<string, unknown>, model.fields),
              body: parsed.content,
            })
          }
          catch { /* skip invalid document */ }
        }

        bundle.content.push([key, entries])
        if (Object.keys(metaBySlug).length > 0) bundle.meta.push([key, metaBySlug])
      }
      catch { /* directory not accessible */ }
    }
    else {
      // JSON kinds: collection, singleton, dictionary
      try {
        const contentPath = resolveContentPath(ctx, model, locale)
        const raw = await git.readFile(contentPath, contentRef)
        bundle.content.push([key, JSON.parse(raw)])
      }
      catch (e) {
        // eslint-disable-next-line no-console
        console.error(`[brain] ✗ Content failed for ${modelId}:${locale}:`, (e as Error).message?.substring(0, 100))
      }

      // Meta
      try {
        const metaPath = resolveMetaPath(ctx, model, locale, defaultLocale)
        bundle.meta.push([key, JSON.parse(await git.readFile(metaPath, contentRef)) as Record<string, unknown>])
      }
      catch { /* no meta */ }
    }
  }))

  return bundle
}

/** Entry counts + locales per model — pure, derived from the content map. */
function computeContentSummary(
  models: Map<string, ModelDefinition>,
  content: Map<string, unknown>,
  defaultLocale: string,
): Record<string, { count: number, locales: string[], kind: ModelKind }> {
  const contentSummary: Record<string, { count: number, locales: string[], kind: ModelKind }> = {}
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
  return contentSummary
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
      fileShas: buildFileShaMap(tree),
      stale: false,
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

  // Recompute tree hash including custom content_paths from models
  const extraContentPaths = [...models.values()]
    .filter(m => m.content_path)
    .map(m => m.content_path!)
  const finalTreeSha = computeTreeHash(tree, extraContentPaths)

  // 4. Read all content + meta for each model
  const content = new Map<string, unknown>()
  const metaMap = new Map<string, Record<string, unknown>>()

  await Promise.all([...models.values()].map(async (model) => {
    const bundle = await readModelBundle(git, ctx, contentRoot, model, supportedLocales, defaultLocale, contentRef)
    for (const [key, value] of bundle.content) content.set(key, value)
    for (const [key, value] of bundle.meta) metaMap.set(key, value)
  }))

  // 4.5 Compute content summaries (after all reads complete — no race condition)
  const contentSummary = computeContentSummary(models, content, defaultLocale)

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
    treeSha: finalTreeSha,
    // Same tracked file set as `finalTreeSha` (extraPaths-aware) so the
    // quick-path hash compare and the SHA diff never disagree.
    fileShas: buildFileShaMap(tree, extraContentPaths),
    stale: false,
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
 * Classify a changed tree path against the cached snapshot's layout.
 *
 * Built FORWARD from the cached models + config (the same path
 * resolvers the readers use) — never by reverse-parsing paths. Anything
 * that doesn't classify cleanly forces a full rebuild, so unknown
 * layouts can never be patched incorrectly.
 */
type PathClass
  = | { type: 'structural' }
    | { type: 'model', modelId: string }
    | { type: 'vocabulary' }
    | { type: 'context' }

function buildPathClassifier(
  ctx: { contentRoot: string },
  contentRoot: string,
  cached: BrainCacheEntry,
): (path: string) => PathClass {
  const configPath = resolveConfigPath(ctx)
  const vocabularyPath = resolveVocabularyPath(ctx)
  const contextPath = resolveContextPath(ctx)
  const modelsDirPrefix = `${resolveModelsDir(ctx)}/`

  // Per model: a content-directory prefix and a meta-directory prefix.
  // Trailing slashes disambiguate sibling ids ("post" vs "posts").
  const modelPrefixes: Array<[string, string]> = []
  for (const [modelId, model] of cached.models) {
    const contentPrefix = model.content_path
      ? `${contentRoot ? `${contentRoot}/` : ''}${model.content_path}/`
      : `${contentRoot ? `${contentRoot}/` : ''}.contentrain/content/${model.domain}/${model.id}/`
    const metaPrefix = `${contentRoot ? `${contentRoot}/` : ''}.contentrain/meta/${model.id}/`
    modelPrefixes.push([contentPrefix, modelId], [metaPrefix, modelId])
  }

  return (path: string): PathClass => {
    if (path === configPath || path.startsWith(modelsDirPrefix)) return { type: 'structural' }
    if (path === vocabularyPath) return { type: 'vocabulary' }
    if (path === contextPath) return { type: 'context' }
    for (const [prefix, modelId] of modelPrefixes) {
      if (path.startsWith(prefix)) return { type: 'model', modelId }
    }
    // Unclassifiable tracked path — layouts we don't model. Rebuild.
    return { type: 'structural' }
  }
}

/**
 * Incrementally refresh a cached snapshot: diff per-path blob SHAs
 * against the current tree and re-read only the affected models (plus
 * vocabulary/context when their files changed). Returns `null` when a
 * structural change (config, models/, unknown path) makes patching
 * unsafe — the caller falls back to a full rebuild.
 */
export async function refreshBrainSnapshot(
  git: GitProvider,
  contentRoot: string,
  projectId: string,
  cached: BrainCacheEntry,
  presetTree?: TreeEntry[],
): Promise<BrainCacheEntry | null> {
  // A config-less snapshot has nothing to patch; full rebuild is cheap.
  if (!cached.config) return null

  // Reads below pin to the contentrain branch. When it is missing —
  // e.g. transiently absent after a merge deletes it — a targeted patch
  // can't proceed, so bail to a full rebuild (`null`). `buildBrainSnapshot`
  // then handles the missing branch by falling back to the default
  // branch; serving the stale cached entry instead would show old
  // content until contentrain reappears.
  const contentRef: string | undefined = CONTENT_REF
  let tree = presetTree
  if (!tree) {
    try {
      tree = await git.getTree(CONTENT_REF)
    }
    catch {
      return null
    }
  }

  const extraPaths = [...cached.models.values()]
    .filter(m => m.content_path)
    .map(m => m.content_path!)
  const newShas = buildFileShaMap(tree, extraPaths)

  const changedPaths: string[] = []
  for (const [path, sha] of newShas) {
    if (cached.fileShas.get(path) !== sha) changedPaths.push(path)
  }
  for (const path of cached.fileShas.keys()) {
    if (!newShas.has(path)) changedPaths.push(path)
  }

  const now = Date.now()
  const newTreeSha = computeTreeHash(tree, extraPaths)

  if (changedPaths.length === 0) {
    const entry: BrainCacheEntry = { ...cached, treeSha: newTreeSha, fileShas: newShas, stale: false, lastRefresh: now }
    return entry
  }

  const ctx = { contentRoot }
  const classify = buildPathClassifier(ctx, contentRoot, cached)
  const affectedModels = new Set<string>()
  let vocabularyChanged = false
  let contextChanged = false

  for (const path of changedPaths) {
    const cls = classify(path)
    if (cls.type === 'structural') return null
    if (cls.type === 'model') affectedModels.add(cls.modelId)
    if (cls.type === 'vocabulary') vocabularyChanged = true
    if (cls.type === 'context') contextChanged = true
  }

  const config = cached.config
  const defaultLocale = config.locales?.default ?? 'en'
  const supportedLocales = config.locales?.supported ?? [defaultLocale]

  // New entry with copied maps — never mutate `cached` in place:
  // concurrent readers hold the old object, and it stays intact as
  // `previousBrain` for breaking-change detection.
  const content = new Map(cached.content)
  const metaMap = new Map(cached.meta)

  await Promise.all([...affectedModels].map(async (modelId) => {
    const model = cached.models.get(modelId)
    if (!model) return
    for (const key of [...content.keys()]) {
      if (key.startsWith(`${modelId}:`)) content.delete(key)
    }
    for (const key of [...metaMap.keys()]) {
      if (key.startsWith(`${modelId}:`)) metaMap.delete(key)
    }
    const bundle = await readModelBundle(git, ctx, contentRoot, model, supportedLocales, defaultLocale, contentRef)
    for (const [key, value] of bundle.content) content.set(key, value)
    for (const [key, value] of bundle.meta) metaMap.set(key, value)
  }))

  let vocabulary = cached.vocabulary
  if (vocabularyChanged) {
    vocabulary = null
    try {
      const vocabData = JSON.parse(await git.readFile(resolveVocabularyPath(ctx), contentRef)) as { terms?: Record<string, Record<string, string>> }
      vocabulary = vocabData.terms ?? null
    }
    catch { /* no vocabulary */ }
  }

  let contentContext = cached.contentContext
  if (contextChanged) {
    contentContext = null
    try {
      contentContext = JSON.parse(await git.readFile(resolveContextPath(ctx), contentRef)) as Record<string, unknown>
    }
    catch { /* no context */ }
  }

  const entry: BrainCacheEntry = {
    treeSha: newTreeSha,
    fileShas: newShas,
    stale: false,
    config,
    models: new Map(cached.models),
    content,
    meta: metaMap,
    vocabulary,
    contentContext,
    contentSummary: computeContentSummary(cached.models, content, defaultLocale),
    schemaValidation: null,
    lastRefresh: now,
    projectId,
  }

  try {
    const { validateProjectSchema } = await import('./schema-validation')
    entry.schemaValidation = validateProjectSchema(entry, cached)
  }
  catch { /* validation failure shouldn't block refresh */ }

  return entry
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

/**
 * CDN Content Build Pipeline.
 *
 * Reads content from Git, filters by meta (published only),
 * serializes to canonical JSON, uploads to CDN storage.
 *
 * CRITICAL: Uses resolveContentPath() for ALL path resolution.
 * Content can live OUTSIDE .contentrain/ via model.content_path override.
 * Never hardcode content paths — always resolve through content-paths.ts.
 */

import type { ModelDefinition, ContentrainConfig } from '@contentrain/types'
import { parseMarkdownFrontmatter } from '@contentrain/types'
import type { GitProvider } from '../providers/git'
import type { CDNProvider } from '../providers/cdn'
import { Marked } from 'marked'
import { normalizeModelContentMedia, rewriteEntryMedia, rewriteMarkdownMedia } from './media-rewrite'
import { reportDataLossRisk } from './alert'

// Configure marked for safe HTML output — escape user HTML input
const safeMarked = new Marked({
  renderer: {
    // Override HTML block/inline to escape raw HTML
    html(token) {
      // Escape raw HTML blocks to prevent XSS
      return token.text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
    },
  },
})

export interface BuildResult {
  projectId: string
  buildId: string
  commitSha: string
  filesUploaded: number
  filesDeleted: number
  totalSizeBytes: number
  changedModels: string[]
  durationMs: number
  error?: string
}

export interface BuildOptions {
  projectId: string
  buildId: string
  git: GitProvider
  cdn: CDNProvider
  contentRoot: string
  commitSha: string
  branch: string
  changedPaths?: string[]
  fullRebuild?: boolean
  onProgress?: (event: BuildProgressEvent) => void
}

export interface BuildProgressEvent {
  phase: 'init' | 'model' | 'upload' | 'cleanup' | 'done'
  message: string
  current?: number
  total?: number
  modelId?: string
}

interface EntryMeta {
  status?: string
  publish_at?: string
  expire_at?: string
  [key: string]: unknown
}

/**
 * Determine if an entry should be included in CDN.
 *
 * Only published content is served via CDN:
 * - status must be 'published' (draft, in_review, rejected, archived excluded)
 * - publish_at must be in the past (or not set)
 * - expire_at must be in the future (or not set)
 * - No meta = include (backward compat for legacy content without meta)
 */
function shouldIncludeEntry(meta: EntryMeta | undefined): boolean {
  if (!meta) return true // No meta = include (legacy content)

  // Status filter — only published content
  if (meta.status && meta.status !== 'published') return false

  const now = new Date()
  if (meta.publish_at && new Date(meta.publish_at) > now) return false
  if (meta.expire_at && new Date(meta.expire_at) < now) return false

  return true
}

/**
 * Determine which models are affected by changed file paths.
 * CRITICAL: Checks both standard .contentrain/ paths AND content_path overrides.
 */
export function getAffectedModels(
  changedPaths: string[],
  models: ModelDefinition[],
  contentRoot: string,
  configPath: string,
): string[] {
  // Config change → full rebuild
  if (changedPaths.some(p => p === configPath)) {
    return models.map(m => m.id)
  }

  const ctx = { contentRoot }
  const affected = new Set<string>()

  for (const path of changedPaths) {
    // Model definition changed
    for (const model of models) {
      const modelPath = resolveModelPath(ctx, model.id)
      if (path === modelPath) {
        affected.add(model.id)
        continue
      }

      // Check if path falls under this model's content directory
      // This handles BOTH standard .contentrain/content/ AND content_path overrides
      const contentDir = getModelContentDir(ctx, model)
      if (contentDir && path.startsWith(contentDir)) {
        affected.add(model.id)
      }

      // Check meta path
      const metaDir = `${contentRoot ? `${contentRoot}/` : ''}.contentrain/meta/${model.id}/`
      if (path.startsWith(metaDir)) {
        affected.add(model.id)
      }
    }
  }

  return Array.from(affected)
}

/**
 * Get the content directory for a model (handles content_path override).
 */
function getModelContentDir(ctx: { contentRoot: string }, model: ModelDefinition): string | null {
  if (model.content_path) {
    return ctx.contentRoot ? `${ctx.contentRoot}/${model.content_path}` : model.content_path
  }
  const prefix = ctx.contentRoot ? `${ctx.contentRoot}/` : ''
  return `${prefix}.contentrain/content/${model.domain}/${model.id}/`
}

/**
 * Execute a CDN build.
 */
export async function executeCDNBuild(options: BuildOptions): Promise<BuildResult> {
  const start = Date.now()
  const { projectId, buildId, git, cdn, contentRoot, commitSha, branch } = options
  const ctx = { contentRoot }
  const progress = options.onProgress ?? (() => {})

  let filesUploaded = 0
  let filesDeleted = 0
  let totalSizeBytes = 0
  const changedModelIds: string[] = []
  const uploadedPaths = new Set<string>()

  // Locale bundles (_bundle/{locale}.json) collect every content body built in
  // this run, keyed by the exact delivery path — the SDK primes its per-path
  // cache from one conditional fetch (docs/CDN_BUNDLE.md). Non-i18n bodies are
  // shared across all locale bundles (locale = null).
  const bundleShared = new Map<string, unknown>()
  const bundleByLocale = new Map<string, Map<string, unknown>>()
  const addBundleEntry = (locale: string | null, entryPath: string, body: unknown): void => {
    if (locale === null) {
      bundleShared.set(entryPath, body)
      return
    }
    let entries = bundleByLocale.get(locale)
    if (!entries) {
      entries = new Map()
      bundleByLocale.set(locale, entries)
    }
    entries.set(entryPath, body)
  }

  try {
    // 1. Load project config
    progress({ phase: 'init', message: 'Loading project config...' })
    const configPath = resolveConfigPath(ctx)
    let config: ContentrainConfig
    try {
      config = JSON.parse(await git.readFile(configPath, branch)) as ContentrainConfig
    }
    catch {
      return {
        projectId, buildId, commitSha, filesUploaded: 0, filesDeleted: 0,
        totalSizeBytes: 0, changedModels: [], durationMs: Date.now() - start,
        error: 'config.json not found',
      }
    }

    const locales = config.locales?.supported ?? [config.locales?.default ?? 'en']

    // 2. Load all model definitions
    progress({ phase: 'init', message: 'Loading model definitions...' })
    const modelsDir = resolveModelsDir(ctx)
    const modelFiles = await git.listDirectory(modelsDir, branch)
    const models: ModelDefinition[] = []
    for (const file of modelFiles) {
      if (!file.endsWith('.json')) continue
      try {
        models.push(JSON.parse(await git.readFile(`${modelsDir}/${file}`, branch)) as ModelDefinition)
      }
      catch { /* skip invalid */ }
    }

    // 3. Determine affected models (selective or full)
    let targetModels: ModelDefinition[]
    if (options.fullRebuild || !options.changedPaths?.length) {
      targetModels = models
    }
    else {
      const affectedIds = getAffectedModels(options.changedPaths, models, contentRoot, configPath)
      targetModels = models.filter(m => affectedIds.includes(m.id))
    }

    changedModelIds.push(...targetModels.map(m => m.id))

    // 4. Upload manifest
    progress({ phase: 'upload', message: 'Uploading manifest...', current: 0, total: targetModels.length })
    const manifest = {
      version: '1',
      commitSha,
      builtAt: new Date().toISOString(),
      branch,
      config: {
        stack: config.stack,
        locales: config.locales,
        domains: config.domains,
      },
      models: models.map(m => ({
        id: m.id,
        name: m.name,
        kind: m.kind,
        domain: m.domain,
        i18n: m.i18n,
      })),
    }
    const manifestData = JSON.stringify(manifest, null, 2)
    await cdn.putObject(projectId, '_manifest.json', manifestData, 'application/json')
    uploadedPaths.add('_manifest.json')
    filesUploaded++
    totalSizeBytes += Buffer.byteLength(manifestData)

    // 5. Upload model index + definitions
    const modelSummaries = models.map(m => ({
      id: m.id,
      name: m.name,
      kind: m.kind,
      domain: m.domain,
      i18n: m.i18n,
      fieldCount: m.fields ? Object.keys(m.fields).length : 0,
    }))
    const indexData = JSON.stringify(modelSummaries, null, 2)
    await cdn.putObject(projectId, 'models/_index.json', indexData, 'application/json')
    uploadedPaths.add('models/_index.json')
    filesUploaded++
    totalSizeBytes += Buffer.byteLength(indexData)

    for (const model of models) {
      const defPath = `models/${model.id}.json`
      const modelData = JSON.stringify(model, null, 2)
      await cdn.putObject(projectId, defPath, modelData, 'application/json')
      uploadedPaths.add(defPath)
      filesUploaded++
      totalSizeBytes += Buffer.byteLength(modelData)
    }

    // 6. Build content for each target model
    let modelStep = 0
    for (const model of targetModels) {
      modelStep++
      progress({ phase: 'model', message: `Building ${model.name}...`, current: modelStep, total: targetModels.length, modelId: model.id })
      for (const locale of locales) {
        // Skip non-i18n models for secondary locales
        if (!model.i18n && locale !== locales[0]) continue
        const effectiveLocale = model.i18n ? locale : 'data'

        try {
          if (model.kind === 'document') {
            const indexEntries = await buildDocumentModel(projectId, git, cdn, ctx, model, locale, branch, uploadedPaths)
            const cdnLocale = model.i18n ? locale : 'data'
            addBundleEntry(model.i18n ? locale : null, `documents/${model.id}/_index/${cdnLocale}.json`, indexEntries)
          }
          else {
            // JSON kinds: collection, singleton, dictionary
            const contentPath = resolveContentPath(ctx, model, effectiveLocale === 'data' ? 'data' : locale)
            const raw = await git.readFile(contentPath, branch)
            let content = JSON.parse(raw)

            // Filter by meta (published only)
            if (model.kind === 'collection') {
              const metaPath = resolveMetaPath(ctx, model, effectiveLocale === 'data' ? locales[0]! : locale)
              let meta: Record<string, EntryMeta> = {}
              try {
                meta = JSON.parse(await git.readFile(metaPath, branch)) as Record<string, EntryMeta>
              }
              catch { /* no meta */ }

              // Filter entries by publication status
              const filtered: Record<string, unknown> = {}
              for (const [id, entry] of Object.entries(content as Record<string, unknown>)) {
                if (shouldIncludeEntry(meta[id])) {
                  filtered[id] = entry
                }
              }
              content = filtered
            }

            // Safety net: rewrite any relative media paths that reached the
            // published artifact (Studio writes already normalize at save).
            content = normalizeModelContentMedia(model, content, projectId)

            const outputPath = `content/${model.id}/${effectiveLocale === 'data' ? 'data' : locale}.json`
            const data = JSON.stringify(content, null, 2)
            await cdn.putObject(projectId, outputPath, data, 'application/json')
            uploadedPaths.add(outputPath)
            filesUploaded++
            totalSizeBytes += Buffer.byteLength(data)
            addBundleEntry(model.i18n ? locale : null, outputPath, content)

            // Upload meta (filtered)
            try {
              const metaPath = resolveMetaPath(ctx, model, effectiveLocale === 'data' ? locales[0]! : locale)
              const metaRaw = await git.readFile(metaPath, branch)
              const metaData = JSON.parse(metaRaw) as Record<string, EntryMeta>

              // Only include published entries' meta
              const filteredMeta: Record<string, EntryMeta> = {}
              for (const [id, m] of Object.entries(metaData)) {
                if (shouldIncludeEntry(m)) filteredMeta[id] = m
              }

              const metaOutput = `meta/${model.id}/${effectiveLocale === 'data' ? 'data' : locale}.json`
              const metaStr = JSON.stringify(filteredMeta, null, 2)
              await cdn.putObject(projectId, metaOutput, metaStr, 'application/json')
              uploadedPaths.add(metaOutput)
              filesUploaded++
              totalSizeBytes += Buffer.byteLength(metaStr)
            }
            catch { /* no meta to upload */ }
          }
        }
        catch {
          // Content file doesn't exist for this locale — skip
        }
      }
    }

    // 6.5 Locale bundles — one conditional fetch replaces N per-model reads
    // (SDK preload mode, docs/CDN_BUNDLE.md). Emitted on every build so the
    // bundle always mirrors the standalone artifacts; skipped only when a
    // selective build touched no models (content unchanged → bundles current).
    const isSelective = !options.fullRebuild && !!options.changedPaths?.length
    if (!isSelective || targetModels.length > 0) {
      if (isSelective) {
        // Selective builds only re-read changed models from git; fill the
        // bundle's gaps from the artifacts already in CDN storage — zero
        // extra git traffic. A missing artifact is skipped; the next full
        // rebuild heals the bundle.
        const targetIds = new Set(targetModels.map(m => m.id))
        for (const model of models) {
          if (targetIds.has(model.id)) continue
          for (const locale of locales) {
            if (!model.i18n && locale !== locales[0]) continue
            const effectiveLocale = model.i18n ? locale : 'data'
            const entryPath = model.kind === 'document'
              ? `documents/${model.id}/_index/${effectiveLocale}.json`
              : `content/${model.id}/${effectiveLocale}.json`
            try {
              const existing = await cdn.getObject(projectId, entryPath)
              // `notModified` guard: forward-compat with conditional reads
              // (never returned without an ifNoneMatch option).
              if (!existing || 'notModified' in existing) continue
              addBundleEntry(model.i18n ? locale : null, entryPath, JSON.parse(existing.data.toString('utf-8')))
            }
            catch { /* unreadable artifact — self-heals on full rebuild */ }
          }
        }
      }

      progress({ phase: 'upload', message: 'Uploading locale bundles...' })
      for (const locale of locales) {
        const paths: Record<string, unknown> = {}
        for (const [entryPath, body] of bundleShared) paths[entryPath] = body
        for (const [entryPath, body] of bundleByLocale.get(locale) ?? []) paths[entryPath] = body
        if (Object.keys(paths).length === 0) continue

        const bundleData = JSON.stringify({
          version: '1',
          commitSha,
          builtAt: new Date().toISOString(),
          locale,
          paths,
        }, null, 2)
        const bundlePath = `_bundle/${locale}.json`
        await cdn.putObject(projectId, bundlePath, bundleData, 'application/json')
        uploadedPaths.add(bundlePath)
        filesUploaded++
        totalSizeBytes += Buffer.byteLength(bundleData)
      }
    }

    // 7. Diff-based stale object cleanup
    progress({ phase: 'cleanup', message: 'Cleaning stale objects...' })
    try {
      if (options.fullRebuild || !options.changedPaths?.length) {
        // Full rebuild: delete every build-owned object not in the new build.
        // The `media/` prefix is out-of-band, owned by the MediaProvider
        // (binaries are uploaded directly on asset upload and are never part
        // of a build's `uploadedPaths`), so it must be excluded from the
        // stale-object sweep — otherwise every full rebuild would delete all
        // media originals + variants while their DB rows and _media_manifest
        // survive, 404-ing every delivery URL.
        const existing = await cdn.listObjects(projectId)
        for (const obj of existing) {
          if (obj.path.startsWith('media/')) continue
          if (!uploadedPaths.has(obj.path)) {
            await cdn.deleteObject(projectId, obj.path)
            filesDeleted++
          }
        }
      }
      else {
        // Selective build: only clean under affected model prefixes
        for (const model of targetModels) {
          const prefixes = [`content/${model.id}/`, `meta/${model.id}/`, `documents/${model.id}/`]
          for (const prefix of prefixes) {
            const existing = await cdn.listObjects(projectId, prefix)
            for (const obj of existing) {
              if (!uploadedPaths.has(obj.path)) {
                await cdn.deleteObject(projectId, obj.path)
                filesDeleted++
              }
            }
          }
        }
      }
    }
    catch (e) {
      // Uploaded content is still correct, but a partial sweep can leave stale
      // or inconsistent objects behind — surface it instead of silently
      // reporting the build as a success.
      reportDataLossRisk(e, { op: 'cdn-build.cleanup', projectId, filesDeleted, fullRebuild: options.fullRebuild ?? false })
    }

    // 8. Media manifest (if MediaProvider is available)
    try {
      const mediaProvider = useMediaProvider()
      if (mediaProvider) {
        const { assets: mediaAssets } = await mediaProvider.listAssets(projectId, { limit: 10000 })
        if (mediaAssets.length > 0) {
          // Build media manifest
          const mediaManifest: Record<string, { original: string, variants: Record<string, string>, meta: Record<string, unknown> }> = {}
          for (const asset of mediaAssets) {
            mediaManifest[asset.originalPath] = {
              original: asset.originalPath,
              variants: Object.fromEntries(Object.entries(asset.variants).map(([k, v]) => [k, v.path])),
              meta: {
                width: asset.width,
                height: asset.height,
                format: asset.format,
                size: asset.size,
                blurhash: asset.blurhash,
                alt: asset.alt,
              },
            }
          }
          const manifestData = JSON.stringify({ version: '1', assets: mediaManifest }, null, 2)
          await cdn.putObject(projectId, '_media_manifest.json', manifestData, 'application/json')
          uploadedPaths.add('_media_manifest.json')
          filesUploaded++
          totalSizeBytes += Buffer.byteLength(manifestData)
        }
      }
    }
    catch {
      // Media manifest generation is non-fatal
    }

    // 9. Purge edge cache
    progress({ phase: 'done', message: `Build complete — ${filesUploaded} uploaded, ${filesDeleted} deleted`, current: targetModels.length, total: targetModels.length })
    await cdn.purgeCache(projectId)

    return {
      projectId,
      buildId,
      commitSha,
      filesUploaded,
      filesDeleted,
      totalSizeBytes,
      changedModels: changedModelIds,
      durationMs: Date.now() - start,
    }
  }
  catch (e: unknown) {
    return {
      projectId,
      buildId,
      commitSha,
      filesUploaded,
      filesDeleted,
      totalSizeBytes,
      changedModels: changedModelIds,
      durationMs: Date.now() - start,
      error: e instanceof Error ? e.message : 'Build failed',
    }
  }
}

/**
 * Build document model — handles slug directories and markdown → HTML.
 * Returns the published index entries so the caller can bundle them.
 *
 * CRITICAL: Documents can live in custom content_path (e.g. "docs/")
 * outside .contentrain/. Uses getModelContentDir() for correct base path.
 *
 * Directory structure:
 *   i18n=true:  {contentDir}/{slug}/{locale}.md
 *   i18n=false: {contentDir}/{slug}.md (flat files, not directories)
 */
async function buildDocumentModel(
  projectId: string,
  git: GitProvider,
  cdn: CDNProvider,
  ctx: { contentRoot: string },
  model: ModelDefinition,
  locale: string,
  branch: string,
  uploadedPaths: Set<string>,
): Promise<Array<Record<string, unknown>>> {
  // Get the content directory — handles content_path override
  const contentDir = getModelContentDir(ctx, model)
  if (!contentDir) return []

  // Remove trailing slash for clean path
  const baseDir = contentDir.replace(/\/$/, '')

  let entries: string[] = []
  try {
    entries = await git.listDirectory(baseDir, branch)
  }
  catch { return [] }

  const indexEntries: Array<Record<string, unknown>> = []

  for (const entry of entries) {
    try {
      let slug: string
      let mdPath: string

      if (model.i18n) {
        // i18n: slug directories containing {locale}.md
        slug = entry
        mdPath = `${baseDir}/${slug}/${locale}.md`
      }
      else {
        // non-i18n: flat .md files (slug = filename without extension)
        if (!entry.endsWith('.md')) continue
        slug = entry.replace(/\.md$/, '')
        mdPath = `${baseDir}/${entry}`
      }

      const raw = await git.readFile(mdPath, branch)
      const { frontmatter, body } = parseMarkdownFrontmatter(raw)

      // Check meta
      try {
        const metaPath = resolveMetaPath(ctx, model, locale, slug)
        const metaRaw = JSON.parse(await git.readFile(metaPath, branch)) as EntryMeta
        if (!shouldIncludeEntry(metaRaw)) continue
      }
      catch { /* no meta = include */ }

      // Rewrite media paths → delivery URLs in the published artifact (git
      // keeps the relative paths). Frontmatter via the model schema; body via
      // markdown src/link targets. HTML is rendered from the rewritten body so
      // its <img src> inherits the absolute URLs.
      const rewrittenFrontmatter = model.fields
        ? rewriteEntryMedia({ ...frontmatter, slug }, model.fields, projectId)
        : { ...frontmatter, slug }
      const rewrittenBody = rewriteMarkdownMedia(body, projectId)
      const html = safeMarked.parse(rewrittenBody, { async: false }) as string

      // Upload individual document
      const cdnLocale = model.i18n ? locale : 'data'
      const docPath = `documents/${model.id}/${slug}/${cdnLocale}.json`
      const docData = JSON.stringify({ frontmatter: rewrittenFrontmatter, body: rewrittenBody, html }, null, 2)
      await cdn.putObject(projectId, docPath, docData, 'application/json')
      uploadedPaths.add(docPath)

      // Add to index
      indexEntries.push({
        ...rewrittenFrontmatter,
        excerpt: rewrittenBody.substring(0, 200).replace(/\n/g, ' ').trim(),
      })
    }
    catch { /* skip invalid document */ }
  }

  // Upload document index
  const cdnLocale = model.i18n ? locale : 'data'
  const docIndexPath = `documents/${model.id}/_index/${cdnLocale}.json`
  const indexData = JSON.stringify(indexEntries, null, 2)
  await cdn.putObject(projectId, docIndexPath, indexData, 'application/json')
  uploadedPaths.add(docIndexPath)

  return indexEntries
}

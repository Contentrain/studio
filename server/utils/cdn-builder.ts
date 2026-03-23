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
import type { GitProvider } from '../providers/git'
import type { CDNProvider } from '../providers/cdn'
import { marked } from 'marked'

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
  phase: 'init' | 'model' | 'upload' | 'done'
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
 * Currently: include everything except explicitly expired entries.
 * Status-based filtering (draft vs published) deferred to Phase 6
 * when scheduled publishing is implemented — right now most entries
 * are 'draft' because there's no publish workflow yet.
 */
function shouldIncludeEntry(meta: EntryMeta | undefined): boolean {
  if (!meta) return true

  const now = new Date()
  // Only exclude entries with explicit scheduling constraints
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
  let totalSizeBytes = 0
  const changedModelIds: string[] = []

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
    filesUploaded++
    totalSizeBytes += Buffer.byteLength(manifestData)

    // 5. Upload model index + definitions
    const modelIndex = models.map(m => ({
      id: m.id,
      name: m.name,
      kind: m.kind,
      domain: m.domain,
      i18n: m.i18n,
      fieldCount: m.fields ? Object.keys(m.fields).length : 0,
    }))
    const indexData = JSON.stringify(modelIndex, null, 2)
    await cdn.putObject(projectId, 'models/_index.json', indexData, 'application/json')
    filesUploaded++
    totalSizeBytes += Buffer.byteLength(indexData)

    for (const model of models) {
      const modelData = JSON.stringify(model, null, 2)
      await cdn.putObject(projectId, `models/${model.id}.json`, modelData, 'application/json')
      filesUploaded++
      totalSizeBytes += Buffer.byteLength(modelData)
    }

    // 6. Build content for each target model
    let modelIndex = 0
    for (const model of targetModels) {
      modelIndex++
      progress({ phase: 'model', message: `Building ${model.name}...`, current: modelIndex, total: targetModels.length, modelId: model.id })
      for (const locale of locales) {
        // Skip non-i18n models for secondary locales
        if (!model.i18n && locale !== locales[0]) continue
        const effectiveLocale = model.i18n ? locale : 'data'

        try {
          if (model.kind === 'document') {
            await buildDocumentModel(projectId, git, cdn, ctx, model, locale, branch)
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

            const outputPath = `content/${model.id}/${effectiveLocale === 'data' ? 'data' : locale}.json`
            const data = JSON.stringify(content, null, 2)
            await cdn.putObject(projectId, outputPath, data, 'application/json')
            filesUploaded++
            totalSizeBytes += Buffer.byteLength(data)

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

    // 7. Purge edge cache
    progress({ phase: 'done', message: `Build complete — ${filesUploaded} files uploaded`, current: targetModels.length, total: targetModels.length })
    await cdn.purgeCache(projectId)

    return {
      projectId,
      buildId,
      commitSha,
      filesUploaded,
      filesDeleted: 0,
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
      filesDeleted: 0,
      totalSizeBytes,
      changedModels: changedModelIds,
      durationMs: Date.now() - start,
      error: e instanceof Error ? e.message : 'Build failed',
    }
  }
}

/**
 * Build document model — handles slug directories and markdown → HTML.
 */
async function buildDocumentModel(
  projectId: string,
  git: GitProvider,
  cdn: CDNProvider,
  ctx: { contentRoot: string },
  model: ModelDefinition,
  locale: string,
  branch: string,
): Promise<void> {
  // Resolve the content directory for this document model
  const contentPath = resolveContentPath(ctx, model, locale)
  // contentPath for documents is like: .contentrain/content/{domain}/{slug}/{locale}.md
  // We need the parent directory to list slugs
  const baseDir = contentPath.replace(`/{locale}.md`, '').replace(`/${locale}.md`, '')
  const parentDir = baseDir.substring(0, baseDir.lastIndexOf('/'))

  let slugDirs: string[] = []
  try {
    slugDirs = await git.listDirectory(parentDir.includes('{slug}') ? getModelContentDir(ctx, model) ?? '' : parentDir, branch)
  }
  catch { return }

  const indexEntries: Array<Record<string, unknown>> = []

  for (const slug of slugDirs) {
    try {
      const mdPath = resolveContentPath(ctx, model, locale, slug)
      const raw = await git.readFile(mdPath, branch)

      // Parse frontmatter
      const { frontmatter, body } = parseMarkdownFrontmatter(raw)

      // Check meta
      try {
        const metaPath = resolveMetaPath(ctx, model, locale, slug)
        const metaRaw = JSON.parse(await git.readFile(metaPath, branch)) as EntryMeta
        if (!shouldIncludeEntry(metaRaw)) continue
      }
      catch { /* no meta = include */ }

      // Render HTML
      const html = marked.parse(body, { async: false }) as string

      // Upload individual document
      const docData = JSON.stringify({ frontmatter: { ...frontmatter, slug }, body, html }, null, 2)
      await cdn.putObject(projectId, `documents/${model.id}/${slug}/${locale}.json`, docData, 'application/json')

      // Add to index
      indexEntries.push({
        slug,
        ...frontmatter,
        excerpt: body.substring(0, 200).replace(/\n/g, ' ').trim(),
      })
    }
    catch { /* skip invalid document */ }
  }

  // Upload document index
  const indexData = JSON.stringify(indexEntries, null, 2)
  await cdn.putObject(projectId, `documents/${model.id}/_index/${locale}.json`, indexData, 'application/json')
}

import type { ModelDefinition } from '@contentrain/types'
import { CONTENTRAIN_DIR, PATH_PATTERNS } from '@contentrain/types'

/**
 * Resolve file paths for Contentrain content operations.
 * Uses PATH_PATTERNS from @contentrain/types as the contract.
 * Handles contentRoot prefix and model-level content_path overrides.
 */

export interface PathContext {
  contentRoot: string // project.content_root normalized ('' or 'apps/web')
}

function prefixed(contentRoot: string, path: string): string {
  return contentRoot ? `${contentRoot}/${path}` : path
}

export function resolveConfigPath(ctx: PathContext): string {
  return prefixed(ctx.contentRoot, PATH_PATTERNS.config)
}

export function resolveModelPath(ctx: PathContext, modelId: string): string {
  return prefixed(ctx.contentRoot, PATH_PATTERNS.model.replace('{modelId}', modelId))
}

/**
 * Content directory (content-root-relative) for a model. Mirrors MCP's
 * `contentDir` (`@contentrain/mcp/core/ops/paths`): a `content_path` override
 * moves files OUTSIDE `.contentrain/`, otherwise they live under the model id.
 * The content_path validation is Studio-only hardening MCP's helper omits.
 */
function resolveContentDirForModel(
  ctx: PathContext,
  model: Pick<ModelDefinition, 'id' | 'domain' | 'content_path'>,
): string {
  if (model.content_path) {
    // Validate content_path — prevent path traversal and sensitive path access
    const normalized = model.content_path.replace(/\\/g, '/')
    if (normalized.includes('..') || normalized.startsWith('/') || normalized.includes('//')) {
      throw new Error(`Invalid content_path: "${model.content_path}" — path traversal detected`)
    }
    // Block sensitive repo paths that should never be content targets
    const sensitivePatterns = ['.github', '.git', 'node_modules', '.env', '.ci', '.contentrain/models', '.contentrain/config']
    const lowerNorm = normalized.toLowerCase()
    if (sensitivePatterns.some(p => lowerNorm === p || lowerNorm.startsWith(`${p}/`))) {
      throw new Error(`Invalid content_path: "${model.content_path}" — targets a protected directory`)
    }
    return prefixed(ctx.contentRoot, model.content_path)
  }
  return prefixed(ctx.contentRoot, `${CONTENTRAIN_DIR}/content/${model.domain}/${model.id}`)
}

/**
 * Resolve the on-disk path for a content file.
 *
 * CRITICAL: honors `model.locale_strategy` — MUST stay byte-for-byte aligned
 * with MCP's canonical `contentFilePath`/`documentFilePath`
 * (`@contentrain/mcp/core/ops/paths`), which is what the write path (`planContentSave`)
 * actually commits. Resolving with the wrong strategy reads a non-existent path
 * → silent skip (missing content in the CDN build + brain cache). `i18n: false`
 * always collapses to `data.json` / `{slug}.md` regardless of strategy.
 *
 * With no `slug` for a document kind, returns the model's content directory
 * (callers use it for `listDirectory`).
 */
export function resolveContentPath(
  ctx: PathContext,
  model: Pick<ModelDefinition, 'id' | 'kind' | 'domain' | 'i18n' | 'content_path' | 'locale_strategy'>,
  locale: string,
  slug?: string,
): string {
  const dir = resolveContentDirForModel(ctx, model)
  const strategy = model.locale_strategy ?? 'file'

  if (model.kind === 'document') {
    if (!slug) return dir
    if (!model.i18n) return `${dir}/${slug}.md`
    switch (strategy) {
      case 'suffix': return `${dir}/${slug}.${locale}.md`
      case 'directory': return `${dir}/${locale}/${slug}.md`
      case 'none': return `${dir}/${slug}.md`
      default: return `${dir}/${slug}/${locale}.md`
    }
  }

  // JSON kinds: collection, singleton, dictionary
  if (!model.i18n) return `${dir}/data.json`
  switch (strategy) {
    case 'suffix': return `${dir}/${model.id}.${locale}.json`
    case 'directory': return `${dir}/${locale}/${model.id}.json`
    case 'none': return `${dir}/${model.id}.json`
    default: return `${dir}/${locale}.json`
  }
}

export function resolveMetaPath(
  ctx: PathContext,
  model: Pick<ModelDefinition, 'id' | 'kind'>,
  locale: string,
  slug?: string,
): string {
  const pattern = PATH_PATTERNS.meta[model.kind as keyof typeof PATH_PATTERNS.meta]
    ?? PATH_PATTERNS.meta.collection

  const resolved = (pattern as string)
    .replace('{modelId}', model.id)
    .replace('{locale}', locale)
    .replace('{slug}', slug ?? '')

  return prefixed(ctx.contentRoot, resolved)
}

export function resolveVocabularyPath(ctx: PathContext): string {
  return prefixed(ctx.contentRoot, PATH_PATTERNS.vocabulary)
}

export function resolveContextPath(ctx: PathContext): string {
  return prefixed(ctx.contentRoot, PATH_PATTERNS.context)
}

export function resolveModelsDir(ctx: PathContext): string {
  return prefixed(ctx.contentRoot, `${CONTENTRAIN_DIR}/models`)
}

export function resolveContentDir(ctx: PathContext): string {
  return prefixed(ctx.contentRoot, `${CONTENTRAIN_DIR}/content`)
}

export function normalizeContentRoot(raw: string): string {
  if (raw === '/' || raw === '') return ''
  return raw.replace(/^\/|\/$/g, '')
}

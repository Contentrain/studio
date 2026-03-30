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

export function resolveContentPath(
  ctx: PathContext,
  model: Pick<ModelDefinition, 'id' | 'kind' | 'domain' | 'i18n' | 'content_path'>,
  locale: string,
  slug?: string,
): string {
  // Custom content_path override — files live OUTSIDE .contentrain/
  if (model.content_path) {
    // Validate content_path — prevent path traversal
    const normalized = model.content_path.replace(/\\/g, '/')
    if (normalized.includes('..') || normalized.startsWith('/') || normalized.includes('//')) {
      throw new Error(`Invalid content_path: "${model.content_path}" — path traversal detected`)
    }
    const basePath = prefixed(ctx.contentRoot, model.content_path)
    if (model.kind === 'document') {
      if (model.i18n && slug) return `${basePath}/${slug}/${locale}.md`
      if (slug) return `${basePath}/${slug}.md`
      return basePath
    }
    // JSON kinds with content_path override
    if (!model.i18n) return `${basePath}/data.json`
    return `${basePath}/${locale}.json`
  }

  // i18n: false → uses noLocale pattern (data.json)
  if (!model.i18n && model.kind !== 'document') {
    const pattern = PATH_PATTERNS.content.noLocale as string
    const resolved = pattern
      .replace('{domain}', model.domain)
      .replace('{modelId}', model.id)
    return prefixed(ctx.contentRoot, resolved)
  }

  // Standard path from PATH_PATTERNS
  const pattern = PATH_PATTERNS.content[model.kind as keyof typeof PATH_PATTERNS.content]
    ?? PATH_PATTERNS.content.collection

  const resolved = (pattern as string)
    .replace('{domain}', model.domain)
    .replace('{modelId}', model.id)
    .replace('{locale}', locale)
    .replace('{slug}', slug ?? '')

  return prefixed(ctx.contentRoot, resolved)
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

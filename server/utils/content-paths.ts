import type { ModelDefinition } from '@contentrain/types'
import { CONTENTRAIN_DIR, PATH_PATTERNS } from '@contentrain/types'
import { contentFilePath, documentFilePath, metaFilePath } from '@contentrain/mcp/core/ops'

/**
 * Resolve file paths for Contentrain content operations.
 *
 * Content + meta path assembly is delegated to MCP's canonical helpers
 * (`@contentrain/mcp/core/ops`: `contentFilePath` / `documentFilePath` /
 * `metaFilePath`) so it can never drift from what `planContentSave` actually
 * commits — the source of a real bug where a non-i18n model's meta fanned out
 * across locales instead of pinning to the default locale. Studio keeps only
 * what MCP's helpers deliberately don't cover: the `contentRoot` prefix, the
 * `content_path` security hardening, and the "return the directory when a
 * document has no slug" case (MCP requires a slug and does not export its
 * `contentDirPath`).
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
 * Studio-only `content_path` hardening that MCP's path helpers omit: reject
 * traversal and protected repo paths BEFORE any assembly delegates to MCP.
 * Called at the top of every public resolver that can honour `content_path`.
 */
function assertSafeContentPath(model: Pick<ModelDefinition, 'content_path'>): void {
  if (!model.content_path) return
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
}

/**
 * Content directory (content-root-relative) for a model. Mirrors MCP's
 * `contentDirPath` (`@contentrain/mcp/core/ops`, not publicly exported): a
 * `content_path` override moves files OUTSIDE `.contentrain/`, otherwise they
 * live under the model id. Prefixed with the project's content root.
 */
function resolveContentDirForModel(
  ctx: PathContext,
  model: Pick<ModelDefinition, 'id' | 'domain' | 'content_path'>,
): string {
  assertSafeContentPath(model)
  const dir = model.content_path ?? `${CONTENTRAIN_DIR}/content/${model.domain}/${model.id}`
  return prefixed(ctx.contentRoot, dir)
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
  assertSafeContentPath(model)

  // A document with no slug → the model's content directory (callers use it
  // for `listDirectory`). MCP's `documentFilePath` requires a slug, so this
  // one case stays Studio-owned.
  if (model.kind === 'document' && !slug) {
    return resolveContentDirForModel(ctx, model)
  }

  // Delegate file-name assembly (locale_strategy + i18n collapse + content_path)
  // to MCP so it stays byte-for-byte aligned with `planContentSave`; Studio only
  // prepends its content-root prefix.
  const rel = model.kind === 'document'
    ? documentFilePath(model, locale, slug!)
    : contentFilePath(model, locale)
  return prefixed(ctx.contentRoot, rel)
}

/**
 * Resolve a model's meta path. `defaultLocale` is required: MCP's `metaFilePath`
 * pins a non-i18n model's single meta record to the default locale (one
 * `data.json` ⇒ one meta record), instead of fanning it out per locale.
 */
export function resolveMetaPath(
  ctx: PathContext,
  model: Pick<ModelDefinition, 'id' | 'kind' | 'i18n'>,
  locale: string,
  defaultLocale: string,
  slug?: string,
): string {
  return prefixed(ctx.contentRoot, metaFilePath(model, locale, defaultLocale, slug))
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

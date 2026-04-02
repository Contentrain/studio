import type { ContentrainConfig, ModelDefinition } from '@contentrain/types'
import type { EngineInternalContext, WriteResult } from './types'
import { BOT_AUTHOR, CONTENT_BRANCH } from './types'
import { createFeatureBranch } from './helpers'

/**
 * Initialize .contentrain/ structure in a repo that doesn't have one.
 * Creates config, context, vocabulary, and empty directories.
 */
export async function initProject(
  ctx: EngineInternalContext,
  stack: string,
  locales: string[],
  domains: string[],
  models: ModelDefinition[],
  userEmail: string,
): Promise<WriteResult> {
  const prefix = ctx.pathCtx.contentRoot ? `${ctx.pathCtx.contentRoot}/` : ''

  // Build config
  const config: ContentrainConfig = {
    version: 1,
    stack: stack as ContentrainConfig['stack'],
    workflow: 'auto-merge',
    locales: {
      default: locales[0] ?? 'en',
      supported: locales,
    },
    domains,
  }

  // Build context
  const context = {
    version: '1',
    lastOperation: {
      tool: 'init_project',
      model: '',
      locale: locales[0] ?? 'en',
      timestamp: new Date().toISOString(),
      source: 'mcp-studio',
    },
    stats: {
      models: models.length,
      entries: 0,
      locales,
      lastSync: new Date().toISOString(),
    },
  }

  // Build vocabulary
  const vocabulary = { version: 1, terms: {} }

  // Collect all files to commit
  const files: Array<{ path: string, content: string }> = [
    { path: `${prefix}.contentrain/config.json`, content: serializeCanonical(config) },
    { path: `${prefix}.contentrain/context.json`, content: serializeCanonical(context) },
    { path: `${prefix}.contentrain/vocabulary.json`, content: serializeCanonical(vocabulary) },
  ]

  // Add model files
  for (const model of models) {
    files.push({
      path: `${prefix}.contentrain/models/${model.id}.json`,
      content: serializeCanonical(model),
    })

    // Create empty content file (non-i18n: single data.json, i18n: per locale)
    if (model.kind !== 'document') {
      const contentLocales = model.i18n ? locales : [locales[0] ?? 'en']
      for (const locale of contentLocales) {
        const effectiveLocale = model.i18n ? locale : 'data'
        const contentPath = resolveContentPath(ctx.pathCtx, model, effectiveLocale)
        files.push({
          path: contentPath,
          content: serializeCanonical({}),
        })
      }
    }

    // Create empty meta file (skip document kind — meta is per-slug)
    if (model.kind !== 'document') {
      for (const locale of locales) {
        const metaPath = resolveMetaPath(ctx.pathCtx, model, locale)
        files.push({
          path: metaPath,
          content: serializeCanonical({}),
        })
      }
    }
  }

  // Ensure contentrain branch + create feature branch (with health check)
  await ctx.ensureContentBranch()
  const { branchName } = await createFeatureBranch(ctx, 'new', 'init')

  const message = `contentrain: initialize project\n\nStack: ${stack}\nLocales: ${locales.join(', ')}\nDomains: ${domains.join(', ')}\nModels: ${models.map(m => m.id).join(', ')}\n\nCo-Authored-By: ${userEmail}`

  const commit = await ctx.git.commitFiles(
    branchName,
    files.map(f => ({ path: f.path, content: f.content })),
    message,
    BOT_AUTHOR,
  )

  const diff = await ctx.git.getBranchDiff(branchName, CONTENT_BRANCH)

  return {
    branch: branchName,
    commit,
    diff,
    validation: { valid: true, errors: [] },
  }
}

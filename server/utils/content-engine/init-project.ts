import type { ContentrainConfig, FileChange, ModelDefinition } from '@contentrain/types'
import { canonicalStringify, CONTENTRAIN_BRANCH as MCP_CONTENTRAIN_BRANCH } from '@contentrain/types'
import type { EngineInternalContext, WriteResult } from './types'
import { BOT_AUTHOR, CONTENT_BRANCH } from './types'
import { createFeatureBranch } from './helpers'

/**
 * Initialize `.contentrain/` structure in a repo that doesn't have one.
 * Studio-specific bootstrap — no MCP plan helper covers this composite
 * write, so Studio assembles the `FileChange[]` directly and commits
 * atomically via `applyPlan`.
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

  const vocabulary = { version: 1, terms: {} }

  const files: FileChange[] = [
    { path: `${prefix}.contentrain/config.json`, content: canonicalStringify(config) },
    { path: `${prefix}.contentrain/context.json`, content: canonicalStringify(context) },
    { path: `${prefix}.contentrain/vocabulary.json`, content: canonicalStringify(vocabulary) },
  ]

  for (const model of models) {
    files.push({
      path: `${prefix}.contentrain/models/${model.id}.json`,
      content: canonicalStringify(model),
    })

    if (model.kind !== 'document') {
      const contentLocales = model.i18n ? locales : [locales[0] ?? 'en']
      for (const locale of contentLocales) {
        const effectiveLocale = model.i18n ? locale : 'data'
        files.push({
          path: resolveContentPath(ctx.pathCtx, model, effectiveLocale),
          content: canonicalStringify({}),
        })
      }

      for (const locale of locales) {
        files.push({
          path: resolveMetaPath(ctx.pathCtx, model, locale),
          content: canonicalStringify({}),
        })
      }
    }
  }

  files.sort((a, b) => a.path.localeCompare(b.path))

  await ctx.ensureContentBranch()
  const { branchName } = await createFeatureBranch(ctx, 'new', 'init')

  const message = `contentrain: initialize project\n\nStack: ${stack}\nLocales: ${locales.join(', ')}\nDomains: ${domains.join(', ')}\nModels: ${models.map(m => m.id).join(', ')}\n\nCo-Authored-By: ${userEmail}`

  const commit = await ctx.git.applyPlan({
    branch: branchName,
    changes: files,
    message,
    author: BOT_AUTHOR,
    base: MCP_CONTENTRAIN_BRANCH,
  })

  const diff = await ctx.git.getBranchDiff(branchName, CONTENT_BRANCH)

  return {
    branch: branchName,
    commit,
    diff,
    validation: { valid: true, errors: [] },
  }
}

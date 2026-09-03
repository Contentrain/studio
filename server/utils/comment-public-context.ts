/**
 * Shared resolver for the public comment endpoints: project → workspace →
 * plan gate → brain cache → model → `comments` config. Both the read and
 * the submit route need exactly this chain; keeping it in one place keeps
 * the two 404/403 surfaces identical (an attacker cannot tell "project
 * exists but comments are off" apart from "no such project").
 */

import type { CommentsConfig } from './comment-types'
import { countCommentEnabledModels, getCommentsConfig, modelSupportsComments } from './comment-types'

export interface PublicCommentContext {
  projectId: string
  workspaceId: string
  plan: ReturnType<typeof getWorkspacePlan>
  workspace: Record<string, unknown>
  modelId: string
  config: CommentsConfig
  /** The project's default locale (`config.locales.default`), the fallback when a request names none. */
  defaultLocale: string
}

export async function resolvePublicCommentContext(projectId: string, modelId: string): Promise<PublicCommentContext> {
  const db = useDatabaseProvider()

  const project = await db.getProjectById(projectId, 'id, workspace_id, repo_full_name, content_root')
  if (!project)
    throw createError({ statusCode: 404, message: errorMessage('comments.not_found') })

  const workspace = await db.getWorkspaceById(project.workspace_id as string, 'id, plan, github_installation_id, overage_settings')
  if (!workspace)
    throw createError({ statusCode: 404, message: errorMessage('comments.not_found') })

  const plan = getWorkspacePlan(workspace)
  if (!hasFeature(plan, 'comments.enabled'))
    throw createError({ statusCode: 403, message: errorMessage('comments.upgrade') })

  if (!workspace.github_installation_id)
    throw createError({ statusCode: 404, message: errorMessage('comments.not_found') })

  const [owner = '', repo = ''] = String(project.repo_full_name).split('/')
  const git = useGitProvider({
    installationId: workspace.github_installation_id as number,
    owner,
    repo,
  })
  const contentRoot = normalizeContentRoot(project.content_root as string)
  const brain = await getOrBuildBrainCache(git, contentRoot, projectId)

  const model = brain.models.get(modelId)
  if (!model)
    throw createError({ statusCode: 404, message: errorMessage('comments.model_not_found') })

  const config = getCommentsConfig(model)
  if (!config?.enabled || !modelSupportsComments(model))
    throw createError({ statusCode: 404, message: errorMessage('comments.disabled') })

  // Enforce the comments.models plan cap the same way forms does: when more
  // models are enabled than the plan allows, only the first N (sorted by id)
  // are served — deterministic, so a downgrade never flips which ones work.
  const modelLimit = getPlanLimit(plan, 'comments.models')
  const enabledCount = countCommentEnabledModels(brain.models)
  if (enabledCount > modelLimit) {
    const allowed = new Set([...brain.models.entries()]
      .filter(([, m]) => getCommentsConfig(m)?.enabled)
      .map(([id]) => id)
      .sort()
      .slice(0, modelLimit))
    if (!allowed.has(modelId))
      throw createError({ statusCode: 403, message: errorMessage('comments.upgrade') })
  }

  const configuredDefault = (brain.config as { locales?: { default?: string } } | null)?.locales?.default
  return {
    projectId,
    workspaceId: workspace.id as string,
    plan,
    workspace: workspace as Record<string, unknown>,
    modelId,
    config,
    defaultLocale: normalizeLocaleParam(configuredDefault, 'en'),
  }
}

/** Validate a locale path/query value against the project's locale grammar. */
export function normalizeLocaleParam(value: unknown, fallback = 'en'): string {
  if (typeof value !== 'string' || !value) return fallback
  return /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(value) ? value : fallback
}

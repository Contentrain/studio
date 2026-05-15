import { createError, getHeader, getQuery, getRouterParam, readBody, type H3Event } from 'h3'
import { useRuntimeConfig } from '#imports'
import type { AIContentBlock } from '../../server/providers/ai'
import type { DatabaseProvider } from '../../server/providers/database'
import type { AgentPermissions } from '../../server/utils/agent-permissions'
import type { ChatUIContext } from '../../server/utils/agent-types'
import { toAITools } from '../../server/utils/agent-types'
import { classifyIntent } from '../../server/utils/agent-context'
import { deriveProjectPhase } from '../../server/utils/agent-state-machine'
import { buildSystemPromptBlocks, toSystemBlocks } from '../../server/utils/agent-system-prompt'
import { STUDIO_TOOLS, filterToolsByPermissions } from '../../server/utils/agent-tools'
import { buildContentIndex, getOrBuildBrainCache } from '../../server/utils/brain-cache'
import { createContentEngine } from '../../server/utils/content-engine'
import { errorMessage } from '../../server/utils/content-strings'
import { normalizeContentRoot } from '../../server/utils/content-paths'
import { runConversationLoop } from '../../server/utils/conversation-engine'
import { buildPromptMessages, selectHistoryBudget } from '../../server/utils/conversation-history'
import { validateConversationKey } from '../../server/utils/conversation-keys'
import { saveApiChatResult } from '../../server/utils/db'
import { getPlanLimit, getWorkspacePlan, hasFeature } from '../../server/utils/license'
import { getEffectiveLimit } from '../../server/utils/overage'
import { checkRateLimit } from '../../server/utils/rate-limit'
import { useDatabaseProvider, useGitProvider } from '../../server/utils/providers'

const API_TOOL_ROLES: Record<string, string[]> = {
  list_models: ['viewer', 'editor', 'admin'],
  get_content: ['viewer', 'editor', 'admin'],
  save_content: ['editor', 'admin'],
  delete_content: ['editor', 'admin'],
  save_model: ['admin'],
  validate: ['viewer', 'editor', 'admin'],
  list_branches: ['viewer', 'editor', 'admin'],
  merge_branch: ['admin'],
  reject_branch: ['admin'],
  init_project: ['admin'],
  copy_locale: ['editor', 'admin'],
  brain_query: ['viewer', 'editor', 'admin'],
  brain_search: ['viewer', 'editor', 'admin'],
  brain_analyze: ['viewer', 'editor', 'admin'],
  validate_schema: ['viewer', 'editor', 'admin'],
  search_media: ['viewer', 'editor', 'admin'],
  upload_media: ['editor', 'admin'],
  get_media: ['viewer', 'editor', 'admin'],
  list_submissions: ['viewer', 'editor', 'admin'],
  approve_submission: ['admin'],
  reject_submission: ['admin'],
}

interface ConversationApiContext {
  db: DatabaseProvider
  keyData: Awaited<ReturnType<typeof validateConversationKey>>
  project: {
    id: string
    repo_full_name: string
    content_root: string
    workspace_id: string
    default_branch: string | null
    detected_stack: string | null
    status: string | null
  }
  workspace: {
    id: string
    github_installation_id: number | null
    plan: string | null
    slug: string | null
    name: string | null
    owner_id: string | null
  }
  plan: ReturnType<typeof getWorkspacePlan>
}

function parseConversationContext(context: Partial<ChatUIContext> | undefined): ChatUIContext {
  return {
    activeModelId: context?.activeModelId ?? null,
    activeLocale: context?.activeLocale ?? 'en',
    activeEntryId: context?.activeEntryId ?? null,
    panelState: context?.panelState ?? 'overview',
    activeBranch: context?.activeBranch ?? null,
  }
}

function buildPermissions(keyData: Awaited<ReturnType<typeof validateConversationKey>>): AgentPermissions {
  const keyRole = keyData.role
  let availableTools = Object.entries(API_TOOL_ROLES)
    .filter(([_, roles]) => roles.includes(keyRole))
    .map(([name]) => name)

  if (keyData.allowedTools.length > 0) {
    availableTools = availableTools.filter(tool => keyData.allowedTools.includes(tool))
  }

  return {
    workspaceRole: keyRole === 'admin' ? 'admin' : 'member',
    projectRole: keyRole === 'admin' ? null : keyRole as AgentPermissions['projectRole'],
    specificModels: keyData.specificModels,
    allowedModels: keyData.allowedModels,
    allowedLocales: keyData.allowedLocales,
    availableTools,
  }
}

async function resolveConversationApiContext(event: H3Event): Promise<ConversationApiContext> {
  const db = useDatabaseProvider()
  const authHeader = getHeader(event, 'authorization')
  const keyData = await validateConversationKey(authHeader)

  const routeProjectId = getRouterParam(event, 'projectId')
  if (!routeProjectId || routeProjectId !== keyData.projectId)
    throw createError({ statusCode: 403, message: errorMessage('conversation.key_invalid') })

  const project = await db.getProjectById(keyData.projectId, 'id, repo_full_name, content_root, workspace_id, default_branch, detected_stack, status')

  if (!project || project.workspace_id !== keyData.workspaceId)
    throw createError({ statusCode: 404, message: errorMessage('project.not_found') })

  const workspace = await db.getWorkspaceById(keyData.workspaceId, 'id, github_installation_id, plan, slug, name, owner_id')

  if (!workspace?.github_installation_id)
    throw createError({ statusCode: 400, message: errorMessage('github.installation_missing') })

  const plan = getWorkspacePlan(workspace)
  if (!hasFeature(plan, 'api.conversation'))
    throw createError({ statusCode: 403, message: errorMessage('conversation.upgrade') })

  return { db, keyData, project: project as ConversationApiContext['project'], workspace: workspace as ConversationApiContext['workspace'], plan }
}

/**
 * Format conversation messages for the `/history.get` route's JSON
 * response. The runtime chat path (`runConversationMessage`) goes
 * through `selectHistoryBudget` + `buildPromptMessages` instead — this
 * shape is purely for external API consumers reading their thread.
 */
async function loadConversationHistoryForResponse(
  db: DatabaseProvider,
  conversationId: string,
  limit: number,
) {
  const messageRows = await db.loadConversationMessages(
    conversationId,
    limit,
    'id, role, content, tool_calls, model, token_count_input, token_count_output, created_at',
  )

  return (messageRows ?? []).map((row: Record<string, unknown>) => ({
    id: row.id,
    role: row.role,
    content: row.content,
    toolCalls: row.tool_calls ?? undefined,
    model: row.model ?? undefined,
    usage: (row.token_count_input || row.token_count_output)
      ? { inputTokens: (row.token_count_input as number) ?? 0, outputTokens: (row.token_count_output as number) ?? 0 }
      : undefined,
    createdAt: row.created_at,
  }))
}

async function runConversationMessage(
  event: H3Event,
  body: { message: string, conversationId?: string, context?: Partial<ChatUIContext> },
) {
  const { db, keyData, project, workspace, plan } = await resolveConversationApiContext(event)

  if (!body.message?.trim())
    throw createError({ statusCode: 400, message: errorMessage('validation.message_required') })

  if (body.message.length > 10_000)
    throw createError({ statusCode: 400, message: errorMessage('validation.message_required') })

  const rateCheck = await checkRateLimit(`conv:${keyData.keyId}`, keyData.rateLimitPerMinute, 60_000)
  if (!rateCheck.allowed)
    throw createError({ statusCode: 429, message: errorMessage('chat.rate_limited', { seconds: Math.ceil(rateCheck.retryAfterMs / 1000) }) })

  // Atomic: enforce per-key AND per-workspace caps in one RPC, then
  // reserve a message slot. `getEffectiveLimit` raises the cap to
  // SOFT_CAP_MAX when overage is enabled or the plan is Infinity, so
  // the RPC stays integer-typed and overage requests fall through to
  // the meter outbox below.
  const usageMonth = new Date().toISOString().substring(0, 7)
  const overageSettings = (event.context as { billing?: { overageSettings?: Record<string, boolean> } }).billing?.overageSettings
  const workspacePlanLimit = getPlanLimit(plan, 'api.messages_per_month')
  const workspaceLimit = getEffectiveLimit(workspacePlanLimit, 'api.messages_per_month', overageSettings)
  const keyLimit = getEffectiveLimit(keyData.monthlyMessageLimit, 'api.messages_per_month', overageSettings)

  // Billing semantic mirrors the Studio chat path: reservation is made
  // up front for race-free cap enforcement, but a message only becomes
  // billable once Anthropic streams a real provider event (text or
  // tool_use). Any failure before that point refunds the slot via the
  // finally below.
  let reserved = false
  let committed = false
  const tryRevert = async (reason: string) => {
    if (!reserved || committed) return
    try {
      await db.decrementAPIUsage({
        workspaceId: keyData.workspaceId,
        apiKeyId: keyData.keyId,
        month: usageMonth,
      })
    }
    catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[conversation-api] usage revert failed (${reason}):`, err)
    }
  }

  try {
    const usageCheck = await db.incrementAPIUsageIfAllowed({
      workspaceId: keyData.workspaceId,
      apiKeyId: keyData.keyId,
      month: usageMonth,
      keyLimit,
      workspaceLimit,
    })
    if (!usageCheck.allowed) {
      const limitForMessage = usageCheck.reason === 'workspace_limit' ? workspacePlanLimit : keyData.monthlyMessageLimit
      throw createError({ statusCode: 429, message: errorMessage('conversation.monthly_limit', { limit: limitForMessage }) })
    }
    reserved = true

    const permissions = buildPermissions(keyData)
    const [owner, repo] = project.repo_full_name.split('/')
    if (!owner || !repo) {
      throw createError({ statusCode: 400, message: errorMessage('github.repo_required') })
    }

    const git = useGitProvider({
      installationId: workspace.github_installation_id ?? 0,
      owner,
      repo,
    })

    const contentRoot = normalizeContentRoot(project.content_root)
    const brain = await getOrBuildBrainCache(git, contentRoot, keyData.projectId)
    const projectConfig = brain.config
    const models = [...brain.models.values()]
    const vocabulary = brain.vocabulary
    const contentContext = brain.contentContext

    const uiContext = parseConversationContext(body.context)

    let pendingBranches: Array<{ name: string, sha: string, protected: boolean }> = []
    try {
      const raw = await git.listBranches('cr/')
      pendingBranches = raw.map(b => ({ name: b.name, sha: b.sha, protected: b.protected ?? false }))
    }
    catch (err) {
    // eslint-disable-next-line no-console
      console.error('[conversation-api] Failed to list branches:', err)
    }

    const phase = deriveProjectPhase(projectConfig, pendingBranches, project.status ?? 'active')
    const intent = classifyIntent(body.message, uiContext, phase)

    const contentIndex = buildContentIndex(brain)
    const promptBlocks = buildSystemPromptBlocks(
      projectConfig,
      models,
      permissions,
      { initialized: !!projectConfig, pendingBranches, projectStatus: project.status ?? 'active', phase, contentContext },
      uiContext,
      intent,
      contentIndex || null,
      vocabulary,
      plan,
      keyData.customInstructions,
    )
    const systemPrompt = toSystemBlocks(promptBlocks)

    const permissionFiltered = filterToolsByPermissions(STUDIO_TOOLS, permissions.availableTools) as typeof STUDIO_TOOLS
    const phaseFiltered = permissionFiltered.filter(tool => tool.requiredPhase.includes(phase))
    const aiTools = toAITools(phaseFiltered)

    // Cache the tools array — same rationale as the Studio chat path.
    if (aiTools.length > 0) {
      aiTools[aiTools.length - 1]!.cacheControl = { type: 'ephemeral' }
    }

    const runtimeConfig = useRuntimeConfig()
    const apiKey = runtimeConfig.anthropic.apiKey
    if (!apiKey)
      throw createError({ statusCode: 500, message: errorMessage('chat.no_api_key') })

    let conversationId = body.conversationId
    if (conversationId) {
      const conv = await db.getConversation(conversationId, keyData.projectId, { apiKeyId: keyData.keyId })

      if (!conv) conversationId = undefined
    }

    if (!conversationId) {
      conversationId = await db.createApiConversation(keyData.projectId, keyData.keyId, body.message.substring(0, 100)) ?? undefined
    }

    if (!conversationId)
      throw createError({ statusCode: 500, message: errorMessage('chat.conversation_create_failed') })

    const model = keyData.aiModel
    const budget = selectHistoryBudget({ plan, model, source: 'api' })
    const historyRows = await db.loadConversationMessages(
      conversationId,
      budget.rowLimit,
      'role, content, tool_calls',
    )
    const messages = buildPromptMessages({
      history: historyRows ?? [],
      newUserMessage: body.message,
      budget,
    })

    const configWorkflow = projectConfig?.workflow ?? 'auto-merge'
    const workflow = hasFeature(plan, 'workflow.review') ? configWorkflow : 'auto-merge'

    const contentEngine = createContentEngine({ git, contentRoot, projectId: keyData.projectId })
    const toolResults: Array<{ id: string, name: string, result: unknown }> = []
    let responseText = ''
    let totalInputTokens = 0
    let totalOutputTokens = 0
    let totalCacheCreationInputTokens = 0
    let totalCacheReadInputTokens = 0
    let lastAssistantContent: AIContentBlock[] = []

    for await (const evt of runConversationLoop(
      { model, apiKey, systemPrompt, messages, tools: aiTools },
      {
        engine: contentEngine,
        git,
        userEmail: `api-key:${keyData.name}`,
        userId: keyData.keyId,
        contentRoot,
        workflow,
        permissions,
        plan,
        projectId: keyData.projectId,
        workspaceId: keyData.workspaceId,
        uiContext,
        phase,
      },
    )) {
    // Commit on first real provider event — see Studio chat handler
    // for the same semantic. `tool_result` is internal, `done` is
    // synthetic, neither counts.
      if (!committed && (evt.type === 'text' || evt.type === 'tool_use')) {
        committed = true
        recordAPIUsage({ workspaceId: keyData.workspaceId, count: 1, apiKeyId: keyData.keyId, month: usageMonth }).catch(() => {})
      }

      switch (evt.type) {
        case 'text':
          responseText += evt.content as string
          break
        case 'tool_result':
          toolResults.push({ id: evt.id as string, name: evt.name as string, result: evt.result })
          break
        case 'done': {
          const u = evt.usage as { inputTokens?: number, outputTokens?: number, cacheCreationInputTokens?: number, cacheReadInputTokens?: number } | undefined
          totalInputTokens = u?.inputTokens ?? 0
          totalOutputTokens = u?.outputTokens ?? 0
          totalCacheCreationInputTokens = u?.cacheCreationInputTokens ?? 0
          totalCacheReadInputTokens = u?.cacheReadInputTokens ?? 0
          lastAssistantContent = (evt.lastContent as AIContentBlock[]) ?? []
          break
        }
      }
    }

    await saveApiChatResult({
      conversationId,
      userMessage: body.message,
      assistantText: responseText,
      assistantContent: lastAssistantContent,
      model,
      inputTokens: totalInputTokens,
      outputTokens: totalOutputTokens,
      cacheCreationInputTokens: totalCacheCreationInputTokens,
      cacheReadInputTokens: totalCacheReadInputTokens,
      workspaceId: keyData.workspaceId,
      apiKeyId: keyData.keyId,
      usageMonth,
    })

    return {
      conversationId,
      message: responseText,
      toolResults: toolResults.length > 0 ? toolResults : undefined,
      usage: {
        inputTokens: totalInputTokens,
        outputTokens: totalOutputTokens,
        cacheCreationInputTokens: totalCacheCreationInputTokens,
        cacheReadInputTokens: totalCacheReadInputTokens,
      },
    }
  }
  finally {
    // Refund the reserved API slot if no real provider event ever
    // flipped `committed` (auth failure to Anthropic, brain/tool init
    // failures after reserve, etc.). After the first text or tool_use
    // event we keep the reservation regardless of downstream outcome.
    await tryRevert('reserve-scope')
  }
}

async function runConversationHistory(event: H3Event) {
  const { db, keyData } = await resolveConversationApiContext(event)

  const query = getQuery(event)
  const conversationId = query.conversationId as string | undefined
  if (!conversationId)
    throw createError({ statusCode: 400, message: errorMessage('validation.conversation_id_required') })

  const conv = await db.getConversation(conversationId, keyData.projectId, { apiKeyId: keyData.keyId })

  if (!conv)
    throw createError({ statusCode: 404, message: errorMessage('chat.conversation_not_found') })

  const limit = Math.min(Number(query.limit ?? 50), 100)
  const messages = await loadConversationHistoryForResponse(db, conversationId, limit)

  return { conversationId, messages }
}

export function createConversationApiBridge() {
  return {
    async handleConversationApiMessage(event: H3Event) {
      const body = await readBody<{ message: string, conversationId?: string, context?: Partial<ChatUIContext> }>(event)
      return await runConversationMessage(event, body)
    },

    async handleConversationApiHistory(event: H3Event) {
      return await runConversationHistory(event)
    },
  }
}

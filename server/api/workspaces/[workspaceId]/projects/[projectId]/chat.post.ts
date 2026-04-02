import type { AIMessage, AIContentBlock } from '~~/server/providers/ai'
import type { ChatRequest } from '~~/server/utils/agent-types'
import { createEventStream } from 'h3'
import { toAITools } from '~~/server/utils/agent-types'
import { deriveProjectPhase } from '~~/server/utils/agent-state-machine'
import { classifyIntent } from '~~/server/utils/agent-context'
import { runConversationLoop } from '~~/server/utils/conversation-engine'
import { resolveEnterpriseChatApiKey } from '../../../../../utils/enterprise'

/**
 * Chat SSE endpoint — Bounded Task Executor.
 *
 * Flow: context enrichment → state machine → intent → bounded prompt → tool loop → affected resources
 *
 * This is a thin wrapper around `runConversationLoop()` from conversation-engine.ts.
 * Endpoint-specific concerns (auth, rate limit, conversation DB, SSE transport) stay here.
 * The AI loop + tool execution logic lives in the reusable engine.
 */

const HISTORY_TOKEN_BUDGET = 8000

export default defineEventHandler(async (event) => {
  const session = requireAuth(event)
  const workspaceId = getRouterParam(event, 'workspaceId')
  const projectId = getRouterParam(event, 'projectId')
  const body = await readBody<ChatRequest>(event)

  if (!workspaceId || !projectId || !body.message)
    throw createError({ statusCode: 400, message: errorMessage('validation.message_required') })

  // Default context if not provided (backward compat)
  const uiContext = body.context ?? {
    activeModelId: null,
    activeLocale: 'en',
    activeEntryId: null,
    panelState: 'overview' as const,
    activeBranch: null,
  }

  const db = useDatabaseProvider()

  // === RESOLVE PROJECT + WORKSPACE ===
  const { project, workspace, git, contentRoot } = await resolveProjectContext(workspaceId, projectId)
  const plan = event.context.billing?.effectivePlan ?? getWorkspacePlan(workspace)

  // === RATE LIMIT ===
  const rateKey = `chat:${session.user.id}`
  const rateCheck = checkRateLimit(rateKey)
  if (!rateCheck.allowed)
    throw createError({ statusCode: 429, message: errorMessage('chat.rate_limited', { seconds: Math.ceil(rateCheck.retryAfterMs / 1000) }) })

  // === PERMISSIONS ===
  const permissions = await resolveAgentPermissions(session.user.id, workspaceId, projectId, session.accessToken)
  if (permissions.availableTools.length === 0)
    throw createError({ statusCode: 403, message: errorMessage('chat.no_permissions') })

  // === API KEY (BYOA available on all plans — resolves user key or falls back to studio key) ===
  const runtimeConfig = useRuntimeConfig()
  let apiKey: string
  let usageSource: 'byoa' | 'studio' = 'studio'

  const enterpriseKey = await resolveEnterpriseChatApiKey({
    workspaceId,
    userId: session.user.id,
    accessToken: session.accessToken,
    plan,
    sessionSecret: runtimeConfig.sessionSecret,
    previousSessionSecret: runtimeConfig.sessionSecretPrevious || undefined,
    studioApiKey: runtimeConfig.anthropic.apiKey,
  })

  if (enterpriseKey) {
    apiKey = enterpriseKey.apiKey
    usageSource = enterpriseKey.usageSource
  }
  else if (runtimeConfig.anthropic.apiKey) {
    apiKey = runtimeConfig.anthropic.apiKey
  }
  else {
    throw createError({ statusCode: 400, message: errorMessage('chat.no_api_key') })
  }

  // === MONTHLY LIMIT — atomic check + reserve (prevents race conditions) ===
  const monthlyLimit = getMonthlyMessageLimit(plan)
  const usageMonth = new Date().toISOString().substring(0, 7)
  if (monthlyLimit !== Infinity) {
    const { allowed } = await db.incrementAgentUsageIfAllowed({
      workspaceId,
      userId: session.user.id,
      month: usageMonth,
      source: usageSource,
      limit: monthlyLimit,
    })
    if (!allowed)
      throw createError({ statusCode: 429, message: errorMessage('chat.monthly_limit_reached', { limit: monthlyLimit }) })
  }

  // === CONVERSATION ===
  let conversationId: string | undefined = body.conversationId

  // Verify ownership if continuing existing conversation
  if (conversationId) {
    const conv = await db.getConversation(conversationId, projectId, { userId: session.user.id })
    if (!conv) {
      conversationId = undefined
    }
  }

  if (!conversationId) {
    conversationId = (await db.createConversation(projectId, session.user.id, body.message)) ?? undefined
  }
  if (!conversationId)
    throw createError({ statusCode: 500, message: errorMessage('chat.conversation_create_failed') })

  // === HISTORY ===
  const historyRows = await db.loadConversationMessages(conversationId, 50)

  // Build message history: chronological order, newest messages prioritized within budget
  const allHistory = historyRows ?? []
  const messages: AIMessage[] = []

  // Walk backwards to find budget cutoff, then take from that point forward
  const budgetStart = (() => {
    let tokens = 0
    for (let i = allHistory.length - 1; i >= 0; i--) {
      const row = allHistory[i]!
      const content = row.tool_calls ? (row.tool_calls as AIContentBlock[]) : row.content
      const estimate = typeof content === 'string' ? Math.ceil(content.length / 4) : Math.ceil(JSON.stringify(content).length / 4)
      tokens += estimate
      if (tokens > HISTORY_TOKEN_BUDGET) return i + 1
    }
    return 0
  })()

  for (let i = budgetStart; i < allHistory.length; i++) {
    const row = allHistory[i]!
    const content = row.tool_calls ? (row.tool_calls as AIContentBlock[]) : (row.content as string | AIContentBlock[])
    messages.push({ role: row.role as 'user' | 'assistant', content })
  }
  messages.push({ role: 'user', content: body.message })

  // === LOAD SCHEMA (from brain cache) ===
  const brain = await getOrBuildBrainCache(git, contentRoot, projectId)
  const projectConfig = brain.config
  const models = [...brain.models.values()]
  const vocabulary = brain.vocabulary
  const contentContext = brain.contentContext

  // === STATE MACHINE ===
  let pendingBranches: Array<{ name: string, sha: string, protected: boolean }> = []
  try {
    pendingBranches = await git.listBranches('cr/')
  }
  catch { /* no branches */ }

  const phase = deriveProjectPhase(projectConfig, pendingBranches, project.status ?? 'active')

  // === INTENT CLASSIFICATION ===
  const intent = classifyIntent(body.message, uiContext, phase)

  // === BUILD SYSTEM PROMPT (bounded, context-aware) ===
  const projectState = {
    initialized: !!projectConfig,
    pendingBranches,
    projectStatus: project.status ?? 'active',
    phase,
    contentContext,
  }

  let systemPrompt = buildSystemPrompt(projectConfig, models, permissions, projectState, uiContext, intent, vocabulary, plan)

  // Append content index from brain cache (compact summary of all content)
  const contentIndex = buildContentIndex(brain)
  if (contentIndex) {
    systemPrompt += `\n\n${contentIndex}`
  }

  // === FILTER TOOLS by permissions + phase ===
  const permissionFiltered = filterToolsByPermissions(STUDIO_TOOLS, permissions.availableTools) as StudioTool[]
  const phaseFiltered = permissionFiltered.filter(t => t.requiredPhase.includes(phase))
  const aiTools = toAITools(phaseFiltered)

  // Model: plan-gated selection
  const ALL_MODELS = ['claude-sonnet-4-20250514', 'claude-opus-4-20250514', 'claude-haiku-4-5-20251001']
  const STARTER_MODELS = ['claude-haiku-4-5-20251001']
  const availableModels = hasFeature(plan, 'ai.studio_key') ? ALL_MODELS : STARTER_MODELS
  const requestedModel = body.model as string | undefined
  const model = (requestedModel && availableModels.includes(requestedModel)) ? requestedModel : availableModels[0]!

  // Workflow: plans without review feature always auto-merge regardless of config
  const configWorkflow = projectConfig?.workflow ?? 'auto-merge'
  const workflow = hasFeature(plan, 'workflow.review') ? configWorkflow : 'auto-merge'

  // === SSE STREAM ===
  const eventStream = createEventStream(event)
  const contentEngine = createContentEngine({ git, contentRoot })
  const abortController = new AbortController()

  const processChat = async () => {
    await eventStream.push(JSON.stringify({ type: 'conversation', id: conversationId }))

    let totalInputTokens = 0
    let totalOutputTokens = 0
    let lastAssistantContent: AIContentBlock[] = []
    let lastAffected: Record<string, unknown> = {}

    try {
      for await (const evt of runConversationLoop(
        { model, apiKey, systemPrompt, messages, tools: aiTools, abortSignal: abortController.signal },
        { engine: contentEngine, git, userEmail: session.user.email ?? '', userId: session.user.id, contentRoot, workflow, permissions, plan, projectId, workspaceId, uiContext, phase },
      )) {
        // Stop processing if client disconnected
        if (abortController.signal.aborted) break

        // Forward all events to SSE stream
        if (evt.type === 'done') {
          // Extract final state from done event before forwarding
          totalInputTokens = (evt.usage as { inputTokens: number })?.inputTokens ?? 0
          totalOutputTokens = (evt.usage as { outputTokens: number })?.outputTokens ?? 0
          lastAssistantContent = (evt.lastContent as AIContentBlock[]) ?? []
          lastAffected = (evt.affected as Record<string, unknown>) ?? {}

          // Forward the done event without lastContent (not needed by client)
          await eventStream.push(JSON.stringify({
            type: 'done',
            usage: evt.usage,
            affected: evt.affected,
          }))
        }
        else {
          await eventStream.push(JSON.stringify(evt))
        }
      }

      // === SAVE TO DB ===
      const assistantText = lastAssistantContent
        .filter(b => b.type === 'text')
        .map(b => (b as { text: string }).text)
        .join('')

      await saveChatResult(
        conversationId, body.message, assistantText,
        lastAssistantContent, model, totalInputTokens, totalOutputTokens,
        workspaceId, session.user.id, usageSource, usageMonth,
      )

      // Emit webhook events for content changes (fire-and-forget)
      if (lastAffected.snapshotChanged) {
        emitWebhookEvent(projectId, workspaceId, 'content.saved', {
          models: (lastAffected.models as string[]) ?? [],
          source: 'studio',
          conversationId,
        }).catch(() => {})
      }
    }
    catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Chat error'
      // eslint-disable-next-line no-console
      console.error('[chat] Error:', msg)
      try {
        await eventStream.push(JSON.stringify({ type: 'error', message: msg }))
      }
      catch { /* stream closed */ }
    }
    finally {
      try {
        await eventStream.close()
      }
      catch { /* already closed */ }
    }
  }

  processChat()
  eventStream.onClosed(() => {
    abortController.abort()
  })
  return eventStream.send()
})

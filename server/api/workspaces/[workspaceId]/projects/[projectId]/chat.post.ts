import type { AIContentBlock } from '~~/server/providers/ai'
import type { ChatRequest } from '~~/server/utils/agent-types'
import { createEventStream } from 'h3'
import { toAITools } from '~~/server/utils/agent-types'
import { deriveProjectPhase } from '~~/server/utils/agent-state-machine'
import { classifyIntent } from '~~/server/utils/agent-context'
import { runConversationLoop } from '~~/server/utils/conversation-engine'
import { buildPromptMessages, selectHistoryBudget } from '~~/server/utils/conversation-history'
import { validateAttachmentBlocks } from '../../../../../utils/attachment-ingest'
import { resolveEnterpriseChatApiKey } from '../../../../../utils/enterprise'
import { getEdition } from '../../../../../utils/license'
import { getEffectiveLimit } from '../../../../../utils/overage'

/**
 * Chat SSE endpoint — Bounded Task Executor.
 *
 * Flow: context enrichment → state machine → intent → bounded prompt → tool loop → affected resources
 *
 * This is a thin wrapper around `runConversationLoop()` from conversation-engine.ts.
 * Endpoint-specific concerns (auth, rate limit, conversation DB, SSE transport) stay here.
 * The AI loop + tool execution logic lives in the reusable engine.
 */

export default defineEventHandler(async (event) => {
  const session = requireAuth(event)
  const workspaceId = getRouterParam(event, 'workspaceId')
  const projectId = getRouterParam(event, 'projectId')
  const body = await readBody<ChatRequest>(event)

  if (!workspaceId || !projectId || !body.message)
    throw createError({ statusCode: 400, message: errorMessage('validation.message_required') })

  // Validate + flatten client-supplied attachment blocks. They were
  // authored by `/attachments` but echoed back here, so they are
  // untrusted: throws 400 on count/size violations, silently drops
  // forged/invalid blocks. The summary feeds the agent system prompt.
  const { blocks: attachmentBlocks, summary: attachmentSummary } = validateAttachmentBlocks(body.attachments, { projectId })
  const userContent: string | AIContentBlock[] = attachmentBlocks.length > 0
    ? [...attachmentBlocks, { type: 'text', text: body.message }]
    : body.message

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
  const rateCheck = await checkRateLimit(rateKey)
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
  // When overage is enabled, the effective limit is raised so requests aren't blocked.
  // Overage cost is computed later from (actual_usage - plan_limit) * overage_price.
  const basePlanLimit = getMonthlyMessageLimit(plan)
  const overageSettings = event.context.billing?.overageSettings as Record<string, boolean> | undefined
  const monthlyLimit = getEffectiveLimit(basePlanLimit, 'ai.messages_per_month', overageSettings)
  const usageMonth = new Date().toISOString().substring(0, 7)

  // Billing semantic: a message is billable only once Anthropic streams
  // its first real provider event (text or tool_use). Pre-AI failures
  // (DB error, brain cache failure, abort before first token) refund
  // the reserved slot via `tryRevert`. Post-first-event failures stay
  // billable — we paid Anthropic for whatever tokens we received.
  let reserved = false
  let committed = false
  const tryRevert = async (reason: string) => {
    if (!reserved || committed || monthlyLimit === Infinity) return
    try {
      await db.decrementAgentUsage({
        workspaceId,
        userId: session.user.id,
        month: usageMonth,
        source: usageSource,
      })
    }
    catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[chat] usage revert failed (${reason}):`, err)
    }
  }

  try {
    if (monthlyLimit !== Infinity) {
      const { allowed } = await db.incrementAgentUsageIfAllowed({
        workspaceId,
        userId: session.user.id,
        month: usageMonth,
        source: usageSource,
        limit: monthlyLimit,
      })
      if (!allowed)
        throw createError({ statusCode: 429, message: errorMessage('chat.monthly_limit_reached', { limit: basePlanLimit }) })
      reserved = true
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

    // Model: plan-gated selection. Picked here (before history) because
    // `selectHistoryBudget` is model-aware — Haiku gets a smaller window
    // than Sonnet/Opus.
    const ALL_MODELS = ['claude-sonnet-4-6', 'claude-opus-4-8', 'claude-haiku-4-5-20251001']
    const STARTER_MODELS = ['claude-haiku-4-5-20251001']
    const availableModels = hasFeature(plan, 'ai.studio_key') ? ALL_MODELS : STARTER_MODELS
    const requestedModel = body.model as string | undefined
    const model = (requestedModel && availableModels.includes(requestedModel)) ? requestedModel : availableModels[0]!

    // === HISTORY ===
    const budget = selectHistoryBudget({ plan, model, source: usageSource })
    // Resume reads need the full Anthropic-protocol trace, including
    // intermediate assistant turns and tool_result blocks — those rows
    // are RLS-hidden from end users but allowed for service-role reads.
    const historyRows = await db.loadConversationMessages(
      conversationId,
      budget.rowLimit,
      undefined,
      { includeInternal: true },
    )
    const messages = buildPromptMessages({
      history: historyRows ?? [],
      newUserMessage: userContent,
      budget,
    })

    // === LOAD SCHEMA (from brain cache) ===
    const brain = await getOrBuildBrainCache(git, contentRoot, projectId)
    const projectConfig = brain.config
    const models = [...brain.models.values()]
    const vocabulary = brain.vocabulary
    const contentContext = brain.contentContext

    // === STATE MACHINE ===
    let pendingBranches: Array<{ name: string, sha: string, protected: boolean }> = []
    try {
      const raw = await git.listBranches('cr/')
      pendingBranches = raw.map(b => ({ name: b.name, sha: b.sha, protected: b.protected ?? false }))
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

    // Build the system prompt as cache-aware blocks: the static body
    // (role, architecture, schema, vocab, permissions, base rules,
    // custom instructions) and the brain content index get their own
    // `cache_control` markers; the dynamic block (UI context, intent,
    // state) follows uncached so request-by-request changes never
    // invalidate the cached prefix.
    const contentIndex = buildContentIndex(brain)
    const promptBlocks = buildSystemPromptBlocks(
      projectConfig, models, permissions, projectState, uiContext, intent,
      contentIndex || null,
      vocabulary, plan, null,
      attachmentSummary,
      getEdition(),
    )
    const systemPrompt = toSystemBlocks(promptBlocks)

    // === FILTER TOOLS by permissions + phase ===
    const permissionFiltered = filterToolsByPermissions(STUDIO_TOOLS, permissions.availableTools) as StudioTool[]
    const phaseFiltered = permissionFiltered.filter(t => t.requiredPhase.includes(phase))
    const aiTools = toAITools(phaseFiltered)

    // Mark the last tool with cache_control so Anthropic caches the
    // entire tools block. Tools rarely change within a session — this
    // is a high-hit-rate third breakpoint after the two system blocks.
    if (aiTools.length > 0) {
      aiTools[aiTools.length - 1]!.cacheControl = { type: 'ephemeral' }
    }

    // Workflow: plans without review feature always auto-merge regardless of config
    const configWorkflow = projectConfig?.workflow ?? 'auto-merge'
    const workflow = hasFeature(plan, 'workflow.review') ? configWorkflow : 'auto-merge'

    // === SSE STREAM ===
    const eventStream = createEventStream(event)
    const contentEngine = createContentEngine({ git, contentRoot, projectId })
    const abortController = new AbortController()

    const processChat = async () => {
      await eventStream.push(JSON.stringify({ type: 'conversation', id: conversationId }))

      let totalInputTokens = 0
      let totalOutputTokens = 0
      let totalCacheCreationInputTokens = 0
      let totalCacheReadInputTokens = 0
      let lastAssistantContent: AIContentBlock[] = []
      let iterations: Array<{ iteration: number, assistantBlocks: AIContentBlock[], toolResultBlocks: AIContentBlock[] }> = []

      try {
        for await (const evt of runConversationLoop(
          { model, apiKey, systemPrompt, messages, tools: aiTools, abortSignal: abortController.signal },
          { engine: contentEngine, git, userEmail: session.user.email ?? '', userId: session.user.id, contentRoot, workflow, permissions, plan, projectId, workspaceId, uiContext, phase },
        )) {
        // Stop processing if client disconnected
          if (abortController.signal.aborted) break

          // Commit on the first billable provider event. `text` and
          // `tool_use` are real Anthropic stream events; `tool_result`
          // is internal (engine-emitted post tool exec), `done` is
          // synthetic, and `error` may fire before any tokens — none
          // of those count as "we paid for an LLM call."
          if (!committed && (evt.type === 'text' || evt.type === 'tool_use')) {
            committed = true
            recordAIUsage({ workspaceId, count: 1, userId: session.user.id, month: usageMonth }).catch(() => {})
          }

          // Forward all events to SSE stream
          if (evt.type === 'done') {
            // Extract final state from done event before forwarding.
            // Engine accumulates all four token buckets (regular
            // input/output + cache creation + cache read) across
            // streaming and non-streaming iterations.
            const u = evt.usage as { inputTokens?: number, outputTokens?: number, cacheCreationInputTokens?: number, cacheReadInputTokens?: number } | undefined
            totalInputTokens = u?.inputTokens ?? 0
            totalOutputTokens = u?.outputTokens ?? 0
            totalCacheCreationInputTokens = u?.cacheCreationInputTokens ?? 0
            totalCacheReadInputTokens = u?.cacheReadInputTokens ?? 0
            lastAssistantContent = (evt.lastContent as AIContentBlock[]) ?? []
            iterations = (evt.iterations as typeof iterations) ?? []

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
        // `saveChatResult` writes the full iteration trace as a
        // single batched INSERT — seed user row, every assistant
        // iteration, every tool_result iteration — under one
        // `turn_id`. Intermediate rows land with `internal=true`
        // (RLS-hidden from the user transcript); only the final
        // assistant row stays visible.
        await saveChatResult({
          conversationId,
          userMessage: body.message,
          userContentBlocks: attachmentBlocks.length > 0 ? (userContent as AIContentBlock[]) : undefined,
          iterations,
          lastAssistantContent,
          model,
          inputTokens: totalInputTokens,
          outputTokens: totalOutputTokens,
          cacheCreationInputTokens: totalCacheCreationInputTokens,
          cacheReadInputTokens: totalCacheReadInputTokens,
          workspaceId,
          userId: session.user.id,
          usageSource,
          usageMonth,
        })

      // Webhook events are now emitted from conversation-engine.ts per tool execution
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
      // Revert the reserved slot if no provider event ever flipped
      // `committed` (provider auth failure, abort before first token,
      // brain/tool init failure that surfaced here, etc.).
        await tryRevert('post-reserve')
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
  }
  catch (err) {
    // Pre-AI failure paths (DB reserve fail → 429 throw; createConversation,
    // loadMessages, brain cache, etc.). processChat hasn't started yet so
    // `committed` is still false; tryRevert refunds the slot if reserved.
    await tryRevert('pre-AI')
    throw err
  }
})

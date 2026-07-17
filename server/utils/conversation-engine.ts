import type { ModelDefinition } from '@contentrain/types'
import type { AIMessage, AIContentBlock, AISystemBlock, AITool, AIUsage } from '~~/server/providers/ai'
import type { ChatUIContext, AffectedResources, ProjectPhase } from '~~/server/utils/agent-types'
import type { AgentPermissions } from '~~/server/utils/agent-permissions'
import type { ExpandModelView } from '~~/server/utils/relation-expand'
import { DEFAULT_MAX_OUTPUT_TOKENS } from '../../shared/utils/ai-models'

/**
 * Conversation Engine — reusable AI conversation loop with tool execution.
 *
 * Extracted from chat.post.ts to enable reuse across:
 * - SSE chat endpoint (chat.post.ts)
 * - Conversation API (future: external AI content operations)
 * - Scheduled/batch content operations (future)
 *
 * Architecture:
 * - AsyncGenerator pattern — caller controls transport (SSE, WebSocket, collect)
 * - Provider-agnostic — uses AIProvider interface, GitProvider interface
 * - All utility functions are Nuxt auto-imported (server/utils/)
 */

// ─── Event Types ───

export interface ConversationEvent {
  type: 'conversation' | 'text' | 'tool_use' | 'tool_input' | 'tool_result' | 'done' | 'error'
  [key: string]: unknown
}

/**
 * One slice of the tool-use loop. `assistantBlocks` is whatever the
 * provider produced this iteration (text + tool_use blocks in order).
 * `toolResultBlocks` is the synthesized tool_result content fed back
 * to Anthropic as the next "user" message — empty for the final
 * iteration when the model stops with `end_turn`. The persister
 * writes each entry as `assistant` + (optional) `user` row pair
 * sharing one `turn_id`.
 */
export interface IterationTrace {
  iteration: number
  assistantBlocks: AIContentBlock[]
  toolResultBlocks: AIContentBlock[]
}

/**
 * Result of consuming one streaming model turn. The streaming events
 * are yielded live to the caller; this is the assembled end-state the
 * loop needs to decide whether to execute tools and continue.
 */
interface ModelStreamResult {
  assistantBlocks: AIContentBlock[]
  currentToolCalls: Array<{ id: string, name: string, input: unknown }>
  stopReason: string | undefined
  usage: AIUsage
}

// ─── Configuration ───

export interface ConversationConfig {
  model: string
  apiKey: string
  /**
   * Either a plain string (single uncached system block) or an array
   * of `AISystemBlock`s with optional cache markers. The engine
   * forwards the value verbatim to the provider — callers that want
   * prompt-cache hits build their blocks via `buildSystemPromptBlocks`.
   */
  systemPrompt: string | AISystemBlock[]
  messages: AIMessage[]
  tools: AITool[]
  maxToolIterations?: number
  maxToolResultLength?: number
  /**
   * Output-token ceiling (`max_tokens`) per model turn. A CAP, not a
   * target — billed on actual output, so a generous value is
   * cost-neutral and only prevents large tool calls (a full dictionary,
   * many entries) from being truncated mid-generation. Callers pass the
   * model-aware value from `maxOutputTokensFor`; defaults to
   * `DEFAULT_MAX_OUTPUT_TOKENS` when omitted.
   */
  maxOutputTokens?: number
  abortSignal?: AbortSignal
}

// ─── Tool Execution Context ───

export interface ToolExecutionContext {
  engine: ReturnType<typeof createContentEngine>
  git: ReturnType<typeof useGitProvider>
  userEmail: string
  userId: string
  contentRoot: string
  workflow: string
  permissions: AgentPermissions
  plan: string
  projectId: string
  workspaceId: string
  uiContext: ChatUIContext
  phase: ProjectPhase
}

// ─── Constants ───

const DEFAULT_MAX_TOOL_ITERATIONS = 8
const DEFAULT_MAX_TOOL_RESULT_LENGTH = 32000

/**
 * Appended to the last tool_result message before the graceful-close
 * wrap call. Without it the wrap just replays the conversation with
 * tools disabled and the model can legitimately answer with empty
 * content (observed on staging) — leaving the turn with no summary.
 * Hardcoded English on purpose (same precedent as the output_truncated
 * message): it instructs the model to answer in the conversation's
 * language, and it is never persisted or shown verbatim.
 */
const GRACEFUL_CLOSE_INSTRUCTION
  = 'You have reached the tool-step limit for this turn. Answer now with a concise summary of what you just did and its results, in the language of the conversation. Do not propose further actions.'

/** Deterministic last-resort summary when even the instructed wrap returns no text. */
function buildFallbackSummary(executedToolNames: string[]): string {
  if (executedToolNames.length === 0)
    return 'The turn reached its step limit before completing any operations. Please retry with a smaller request.'
  const counts = new Map<string, number>()
  for (const name of executedToolNames) counts.set(name, (counts.get(name) ?? 0) + 1)
  const parts = [...counts.entries()].map(([name, n]) => (n > 1 ? `${name} ×${n}` : name))
  return `Completed ${executedToolNames.length} operation(s) before reaching the step limit for this turn: ${parts.join(', ')}. The results above reflect what was applied.`
}

// ─── Conversation Loop ───

/**
 * Run the conversation loop — streams AI responses, executes tools.
 * Yields ConversationEvent objects that the caller pipes to SSE or collects.
 *
 * The generator handles:
 * - Every iteration: streaming via AIProvider.streamCompletion (the
 *   first turn AND every post-tool continuation) so output streams live
 *   instead of arriving as one buffered block
 * - State machine checks before tool execution
 * - Tool result truncation for context window management
 * - Graceful close: a final tools-disabled summary turn if the loop
 *   hits the iteration ceiling while the model still wants tools
 * - Affected resource accumulation across tool calls
 *
 * The final event is always { type: 'done' } with usage, affected, and lastContent.
 */
export async function* runConversationLoop(
  config: ConversationConfig,
  toolCtx: ToolExecutionContext,
): AsyncGenerator<ConversationEvent> {
  const maxIterations = config.maxToolIterations ?? DEFAULT_MAX_TOOL_ITERATIONS
  const maxResultLength = config.maxToolResultLength ?? DEFAULT_MAX_TOOL_RESULT_LENGTH
  const maxOutputTokens = config.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS
  const aiProvider = useAIProvider()

  let totalInputTokens = 0
  let totalOutputTokens = 0
  let totalCacheCreationInputTokens = 0
  let totalCacheReadInputTokens = 0
  let lastAssistantContent: AIContentBlock[] = []
  let accumulatedAffected: AffectedResources = emptyAffected()
  // Names of tools that actually executed this turn — feeds the
  // graceful-close fallback summary when the wrap call returns no text.
  const executedToolNames: string[] = []
  // Full iteration-by-iteration trace surfaced on `done` so the
  // caller can persist the actual Anthropic-protocol shape Claude
  // saw — intermediate assistant turns AND tool_result blocks —
  // and reconstruct it on resume. Empty for the seed user message;
  // populated for every loop iteration regardless of stop reason.
  const trace: IterationTrace[] = []

  // Consume one streaming model turn. Yields ConversationEvents (text
  // deltas, tool_use starts, errors) as they arrive so the SSE caller
  // forwards them live, and returns the assembled iteration result.
  // Used for EVERY iteration — the first turn AND every post-tool
  // continuation — so the assistant's follow-up answer streams
  // token-by-token instead of arriving as one buffered block.
  // `toolsOverride` lets the graceful-close pass disable tools to force
  // a final summary.
  async function* runModelStream(
    maxTokens: number,
    toolsOverride?: AITool[],
  ): AsyncGenerator<ConversationEvent, ModelStreamResult> {
    const assistantBlocks: AIContentBlock[] = []
    const currentToolCalls: Array<{ id: string, name: string, input: unknown }> = []
    const usage: AIUsage = { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 }
    let stopReason: string | undefined
    let currentText = ''
    const flushText = () => {
      if (!currentText) return
      assistantBlocks.push({ type: 'text', text: currentText })
      currentText = ''
    }

    for await (const streamEvent of aiProvider.streamCompletion(
      { model: config.model, system: config.systemPrompt, messages: config.messages, tools: toolsOverride ?? config.tools, maxTokens, abortSignal: config.abortSignal },
      config.apiKey,
    )) {
      switch (streamEvent.type) {
        case 'text':
          currentText += streamEvent.content ?? ''
          yield { type: 'text', content: streamEvent.content }
          break
        case 'tool_use_start':
          flushText()
          yield { type: 'tool_use', id: streamEvent.toolId, name: streamEvent.toolName }
          break
        case 'tool_use_end': {
          const input = (typeof streamEvent.toolInput === 'object' && streamEvent.toolInput !== null) ? streamEvent.toolInput : {}
          currentToolCalls.push({ id: streamEvent.toolId!, name: streamEvent.toolName!, input })
          assistantBlocks.push({ type: 'tool_use', id: streamEvent.toolId!, name: streamEvent.toolName!, input })
          // The model has finished emitting the call but execution hasn't
          // started — surface the input now so the client card can show
          // what's being done during the (potentially long) pending window.
          yield { type: 'tool_input', id: streamEvent.toolId, input }
          break
        }
        case 'message_end':
          flushText()
          usage.inputTokens += streamEvent.usage?.inputTokens ?? 0
          usage.outputTokens += streamEvent.usage?.outputTokens ?? 0
          usage.cacheCreationInputTokens += streamEvent.usage?.cacheCreationInputTokens ?? 0
          usage.cacheReadInputTokens += streamEvent.usage?.cacheReadInputTokens ?? 0
          stopReason = streamEvent.stopReason
          break
        case 'error':
          yield { type: 'error', message: streamEvent.error }
          break
      }
    }

    return { assistantBlocks, currentToolCalls, stopReason, usage }
  }

  let iteration = 0
  let lastStopReason: string | undefined

  // Turn-scoped merge coalescing: write tools land on contentrain
  // per-save; context regen + contentrain→main advance run once here.
  const turnMerge: TurnMergeState = { pendingFinalize: [] }
  let turnMergeFlushed = false
  const flushTurnMerges = async (): Promise<void> => {
    if (turnMergeFlushed || turnMerge.pendingFinalize.length === 0) return
    turnMergeFlushed = true
    try {
      await toolCtx.engine.finalizeContentrain(turnMerge.pendingFinalize)
    }
    catch (e) {
      // Best-effort, same contract as per-save regen: context.json and
      // the main advance self-heal on the next merge.
      // eslint-disable-next-line no-console
      console.warn('[conversation] turn-end finalize failed (self-heals on next merge):', e instanceof Error ? e.message : e)
    }
  }

  try {
    while (iteration < maxIterations) {
      if (config.abortSignal?.aborted) break

      iteration++

      const turn = yield* runModelStream(maxOutputTokens)
      totalInputTokens += turn.usage.inputTokens
      totalOutputTokens += turn.usage.outputTokens
      totalCacheCreationInputTokens += turn.usage.cacheCreationInputTokens
      totalCacheReadInputTokens += turn.usage.cacheReadInputTokens
      lastStopReason = turn.stopReason
      lastAssistantContent = turn.assistantBlocks

      // === OUTPUT-TOKEN TRUNCATION ===
      // The model hit the `max_tokens` ceiling mid-response. If it was
      // emitting a tool call, that call was cut off before completion —
      // no `tool_use_end` fires, so it never lands in `currentToolCalls`
      // and never executes. Treating this as a normal end-of-turn (the
      // generic check below) strands the user on a "…saving now:"
      // preamble whose action silently never ran. Instead: keep the
      // partial (text-only) content for the transcript, surface a
      // typed error the client localizes, and end the turn honestly.
      if (turn.stopReason === 'max_tokens') {
        trace.push({ iteration, assistantBlocks: turn.assistantBlocks, toolResultBlocks: [] })
        yield {
          type: 'error',
          code: 'output_truncated',
          message: 'The response was cut off at the output-token limit before it finished. Any pending save/create did not run. Split large operations into smaller steps (e.g. one locale or a few entries per call) and retry.',
        }
        break
      }

      if (turn.stopReason !== 'tool_use' || turn.currentToolCalls.length === 0) {
      // Final iteration — no tool execution this turn. Persist the
      // assistant blocks alone (no tool_result row will exist for
      // this iteration).
        trace.push({ iteration, assistantBlocks: turn.assistantBlocks, toolResultBlocks: [] })
        break
      }

      // === TOOL EXECUTION with state guard + workflow-aware auto-merge ===
      const toolResultBlocks: AIContentBlock[] = []

      for (const tc of turn.currentToolCalls) {
      // Stop tool execution if client disconnected
        if (config.abortSignal?.aborted) {
          toolResultBlocks.push({ type: 'tool_result', toolUseId: tc.id, content: JSON.stringify({ error: 'Request cancelled' }) })
          continue
        }

        // State machine guard
        const stateCheck = checkStateTransition(toolCtx.phase, tc.name)
        if (!stateCheck.allowed) {
          const errorResult = { error: stateCheck.reason, suggestion: stateCheck.suggestion }
          yield { type: 'tool_result', id: tc.id, name: tc.name, input: tc.input, result: errorResult }
          toolResultBlocks.push({ type: 'tool_result', toolUseId: tc.id, content: JSON.stringify(errorResult) })
          continue
        }

        // Execute tool
        const result = await executeToolWithAutoMerge(
          tc.name, tc.input, toolCtx.engine, toolCtx.git, toolCtx.userEmail, toolCtx.userId, toolCtx.contentRoot, toolCtx.workflow, toolCtx.permissions, toolCtx.plan, toolCtx.projectId, toolCtx.workspaceId, toolCtx.uiContext, turnMerge,
        )
        executedToolNames.push(tc.name)

        // Accumulate affected resources
        accumulatedAffected = mergeAffected(accumulatedAffected, result.affected)

        // Truncate for context. The cap is intentionally generous (see
        // DEFAULT_MAX_TOOL_RESULT_LENGTH) so full content entries survive
        // intact — an over-tight cap previously chopped reads into invalid
        // JSON mid-object, which sent the agent in circles re-reading the
        // same content it could never see in full.
        let resultStr = JSON.stringify(result.result)
        if (resultStr.length > maxResultLength) {
          resultStr = resultStr.substring(0, maxResultLength) + '\n...(truncated — result exceeded the size limit; narrow the query, e.g. by entryId or locale, to read the rest)'
        }

        // Carry this tool's affected resources on the event so the client
        // can refresh the context panel live (debounced) as each operation
        // lands, instead of only once the whole turn finishes on `done`.
        yield { type: 'tool_result', id: tc.id, name: tc.name, input: tc.input, result: result.result, affected: result.affected }
        toolResultBlocks.push({ type: 'tool_result', toolUseId: tc.id, content: resultStr })
      }

      config.messages.push({ role: 'assistant', content: turn.assistantBlocks })
      config.messages.push({ role: 'user', content: toolResultBlocks })
      lastAssistantContent = turn.assistantBlocks
      trace.push({ iteration, assistantBlocks: turn.assistantBlocks, toolResultBlocks })
    }

    // === GRACEFUL CLOSE on iteration exhaustion ===
    // If the loop hit the iteration ceiling while the model still wanted
    // to call tools (it never reached a natural end_turn), the user would
    // otherwise be left with an answer that stops mid-work. Make one final
    // tools-disabled streaming call so the model summarizes what it did —
    // streamed live, and recorded as the final visible assistant turn.
    if (!config.abortSignal?.aborted && iteration >= maxIterations && lastStopReason === 'tool_use') {
      // Nudge the wrap with an explicit summarize instruction appended
      // after the final tool_result blocks. REPLACE the message — never
      // mutate its content array, which `trace` still references — so
      // the instruction lives only in this one API call and is never
      // persisted or replayed on resume.
      const lastMsg = config.messages[config.messages.length - 1]
      if (lastMsg?.role === 'user' && Array.isArray(lastMsg.content)) {
        config.messages[config.messages.length - 1] = {
          role: 'user',
          content: [...lastMsg.content, { type: 'text', text: GRACEFUL_CLOSE_INSTRUCTION }],
        }
      }

      const wrap = yield* runModelStream(maxOutputTokens, [])
      totalInputTokens += wrap.usage.inputTokens
      totalOutputTokens += wrap.usage.outputTokens
      totalCacheCreationInputTokens += wrap.usage.cacheCreationInputTokens
      totalCacheReadInputTokens += wrap.usage.cacheReadInputTokens

      const wrapText = wrap.assistantBlocks
        .filter(b => b.type === 'text')
        .map(b => (b as { text: string }).text)
        .join('')
        .trim()
      if (wrapText) {
        lastAssistantContent = wrap.assistantBlocks
        trace.push({ iteration: iteration + 1, assistantBlocks: wrap.assistantBlocks, toolResultBlocks: [] })
      }
      else {
        // Observed on staging: the wrap can return zero blocks without
        // erroring, which used to leave the turn with no summary at all.
        // Synthesize a deterministic one so the transcript never ends
        // tool-only.
        // eslint-disable-next-line no-console
        console.warn('[conversation] graceful-close wrap returned no text; synthesizing fallback summary')
        const fallbackText = buildFallbackSummary(executedToolNames)
        yield { type: 'text', content: fallbackText }
        lastAssistantContent = [{ type: 'text', text: fallbackText }]
        trace.push({ iteration: iteration + 1, assistantBlocks: lastAssistantContent, toolResultBlocks: [] })
      }
    }

    // Flush BEFORE the done event so the client's done-triggered refresh
    // sees the finalized context.json / advanced main.
    await flushTurnMerges()

    // === DONE with affected resources ===
    yield {
      type: 'done',
      usage: {
        inputTokens: totalInputTokens,
        outputTokens: totalOutputTokens,
        cacheCreationInputTokens: totalCacheCreationInputTokens,
        cacheReadInputTokens: totalCacheReadInputTokens,
      },
      affected: accumulatedAffected,
      lastContent: lastAssistantContent,
      iterations: trace,
    }
  }
  finally {
    // Single guaranteed exit point: mid-turn throws, aborts, and early
    // generator termination (client disconnect → .return()) all pass
    // through here — branches that already landed on contentrain still
    // get their finalize (context regen + main advance).
    await flushTurnMerges()
  }
}

// ─── Tool Execution ───

/**
 * Per-turn merge coalescing state. Write tools land their branch on
 * `contentrain` immediately (durability unchanged) and queue the
 * finalize step — context.json regeneration + contentrain→main advance
 * — which the conversation loop flushes ONCE at turn end instead of
 * once per write.
 */
export interface TurnMergeState {
  pendingFinalize: string[]
}

/**
 * Merge a write tool's branch. With a `turnMerge` state, only step 1
 * (cr/* → contentrain) runs now and the finalize is queued for the
 * turn-end flush. Without one (standalone callers), this is the exact
 * legacy `engine.mergeBranch` behavior.
 */
async function mergeForTool(
  engine: ReturnType<typeof createContentEngine>,
  branch: string,
  turnMerge?: TurnMergeState,
): Promise<{ merged: boolean }> {
  if (!turnMerge) return engine.mergeBranch(branch)
  const step1 = await engine.mergeToContentrain(branch)
  if (step1.merged) turnMerge.pendingFinalize.push(branch)
  return { merged: step1.merged }
}

/**
 * Execute tool with workflow-aware auto-merge and affected resources.
 */
export async function executeToolWithAutoMerge(
  name: string,
  input: unknown,
  engine: ReturnType<typeof createContentEngine>,
  git: ReturnType<typeof useGitProvider>,
  userEmail: string,
  userId: string,
  contentRoot: string,
  workflow: string,
  permissions: AgentPermissions,
  plan: string,
  projectId: string,
  workspaceId: string,
  uiContext: ChatUIContext,
  turnMerge?: TurnMergeState,
): Promise<{ result: unknown, affected: AffectedResources }> {
  const params = (input ?? {}) as Record<string, unknown>
  const affected: AffectedResources = emptyAffected()
  // Plans without review workflow support always auto-publish on save.
  const autoPublish = !hasFeature(plan, 'workflow.review')

  // Execution-time authorization backstop. chat.post.ts already filters
  // the tool list handed to the model, but a hallucinated/forged tool
  // name — or any future caller that reuses this engine without
  // pre-filtering (the Conversation API / scheduled ops anticipated in
  // this module's docstring) — must not bypass the role check. Every
  // other governance dimension (model access, plan features, phase) is
  // re-enforced below; the role dimension needs the same hard backstop.
  if (!permissions.availableTools.includes(name)) {
    return { result: { error: errorMessage('chat.tool_forbidden', { tool: name }) }, affected }
  }

  try {
    let result: unknown

    switch (name) {
      case 'list_models': {
        // Read from brain cache instead of Git
        const brainData = await getOrBuildBrainCache(git, contentRoot, projectId)
        result = { models: [...brainData.models.values()] }
        break
      }

      case 'get_content': {
        // Redirect to brain_query — reads from cache instead of Git
        const brainData = await getOrBuildBrainCache(git, contentRoot, projectId)
        const modelId = params.model as string
        if (permissions.specificModels && !permissions.allowedModels.includes(modelId)) {
          result = { error: `${errorMessage('model.access_denied')}: ${modelId}` }
          break
        }
        const locale = (params.locale as string) ?? uiContext.activeLocale ?? 'en'
        if (permissions.allowedLocales?.length && !permissions.allowedLocales.includes(locale)) {
          result = { error: `Locale "${locale}" is not allowed for this API key` }
          break
        }
        const key = `${modelId}:${locale}`
        const contentData = brainData.content.get(key) ?? null
        const metaData = brainData.meta.get(key) ?? null
        const modelDef = brainData.models.get(modelId)
        if (!contentData) {
          result = { modelId, locale, kind: modelDef?.kind ?? 'collection', data: null, error: errorMessage('content.not_found') }
        }
        else {
          result = { modelId, locale, kind: modelDef?.kind ?? 'collection', data: contentData, meta: metaData }
        }
        break
      }

      case 'save_content': {
        const modelId = params.model as string
        if (permissions.specificModels && !permissions.allowedModels.includes(modelId)) {
          result = { error: `${errorMessage('model.access_denied')}: ${modelId}` }
          break
        }
        const locale = (params.locale as string) ?? 'en'
        if (permissions.allowedLocales?.length && !permissions.allowedLocales.includes(locale)) {
          result = { error: `Locale "${locale}" is not allowed for this API key` }
          break
        }

        // Relation referential-integrity pre-flight (brain-backed). Structural
        // validation checks a relation value's SHAPE but not whether the target
        // EXISTS; this mirrors the UI's constrained relation picker so the agent
        // cannot commit a dangling reference. Best-effort — skips silently if the
        // brain lacks the model/fields rather than blocking on an infra gap.
        const relBrain = await getOrBuildBrainCache(git, contentRoot, projectId)
        const relFields = relBrain.models.get(modelId)?.fields
        if (relFields) {
          const relKind = relBrain.models.get(modelId)?.kind
          const relDefaultLocale = (relBrain.config as { locales?: { default?: string } } | null)?.locales?.default ?? 'en'
          const getRefs = (m: string) => brainContentRefs(
            relBrain.content.get(`${m}:${locale}`) ?? relBrain.content.get(`${m}:${relDefaultLocale}`),
          )
          const relEntries: Record<string, unknown>[] = []
          if (params.slug && typeof params.slug === 'string') {
            relEntries.push((params.data ?? params.frontmatter ?? {}) as Record<string, unknown>)
          }
          else if (relKind === 'collection') {
            for (const e of Object.values((params.data ?? {}) as Record<string, unknown>)) {
              if (e && typeof e === 'object') relEntries.push(e as Record<string, unknown>)
            }
          }
          else {
            relEntries.push((params.data ?? {}) as Record<string, unknown>)
          }
          const relErrors = relEntries.flatMap(e => findBrokenRelations(e, relFields, getRefs))
          if (relErrors.length > 0) {
            result = { error: `${errorMessage('content.relation_not_found')}: ${relErrors.join('; ')}` }
            break
          }
        }

        let writeResult: { branch: string, commit: { sha: string }, diff: unknown[], validation: { valid: boolean, errors: Array<{ message: string }> } }

        // Document kind: expects { slug, frontmatter/data, body }
        if (params.slug && typeof params.slug === 'string') {
          const frontmatter = (params.data ?? params.frontmatter ?? {}) as Record<string, unknown>
          const body = (params.body as string) ?? ''
          writeResult = await engine.saveDocument(modelId, locale, params.slug as string, frontmatter, body, userEmail, { autoPublish })
        }
        else {
          writeResult = await engine.saveContent(modelId, locale, params.data as Record<string, unknown>, userEmail, { autoPublish })
        }

        // Surface validation failure as a HARD error. Previously a failed
        // save returned an empty branch and `summarizeWriteResult` buried
        // the errors in an `errors[]` array alongside `merged:false`, which
        // the model frequently read as a soft/partial success. This makes
        // malformed field values and relation-shape / polymorphic-target
        // mismatches (which `validateContent` catches) a clear, actionable
        // error the agent must fix before retrying. (Mirrors the
        // copy_locale validation guard below.)
        if (!writeResult.validation.valid) {
          result = { error: `${errorMessage('content.validation_failed')}: ${writeResult.validation.errors.map(e => e.message).join('; ')}` }
          break
        }

        affected.models.push(modelId)
        affected.locales.push(locale)
        affected.branchesChanged = true
        invalidateBrainCache(projectId)

        // Role-aware auto-merge
        if (shouldAutoMerge(workflow, permissions) && writeResult.branch) {
          const mergeResult = await mergeForTool(engine, writeResult.branch, turnMerge)
          result = { ...summarizeWriteResult(writeResult), merged: mergeResult.merged, workflow }
        }
        else if (writeResult.branch) {
          result = { ...summarizeWriteResult(writeResult), merged: false, workflow, reviewBranch: writeResult.branch }
        }
        else {
          result = { ...summarizeWriteResult(writeResult), merged: false, workflow }
        }

        // Emit webhook event (fire-and-forget)
        emitWebhookEvent(projectId, workspaceId, 'content.saved', {
          models: [modelId],
          locale,
          source: 'conversation',
        }).catch(() => {})
        break
      }

      case 'delete_content': {
        const modelId = params.model as string
        if (permissions.specificModels && !permissions.allowedModels.includes(modelId)) {
          result = { error: `${errorMessage('model.access_denied')}: ${modelId}` }
          break
        }
        const locale = (params.locale as string) ?? 'en'
        if (permissions.allowedLocales?.length && !permissions.allowedLocales.includes(locale)) {
          result = { error: `Locale "${locale}" is not allowed for this API key` }
          break
        }
        const writeResult = await engine.deleteContent(modelId, locale, params.entryIds as string[], userEmail)
        affected.models.push(modelId)
        affected.locales.push(locale)
        affected.branchesChanged = true
        invalidateBrainCache(projectId)

        if (shouldAutoMerge(workflow, permissions)) {
          const mergeResult = await mergeForTool(engine, writeResult.branch, turnMerge)
          result = { ...summarizeWriteResult(writeResult), merged: mergeResult.merged }
        }
        else {
          result = { ...summarizeWriteResult(writeResult), merged: false, reviewBranch: writeResult.branch }
        }

        // Emit webhook event (fire-and-forget)
        emitWebhookEvent(projectId, workspaceId, 'content.deleted', {
          models: [modelId],
          locale,
          entryIds: params.entryIds as string[],
          source: 'conversation',
        }).catch(() => {})
        break
      }

      case 'save_model': {
        const writeResult = await engine.saveModel(params as unknown as ModelDefinition, userEmail)
        affected.snapshotChanged = true
        affected.branchesChanged = true
        invalidateBrainCache(projectId)

        if (shouldAutoMerge(workflow, permissions)) {
          const mergeResult = await mergeForTool(engine, writeResult.branch, turnMerge)
          result = { ...summarizeWriteResult(writeResult), merged: mergeResult.merged }
        }
        else {
          result = { ...summarizeWriteResult(writeResult), merged: false, reviewBranch: writeResult.branch }
        }

        // Emit webhook event (fire-and-forget)
        emitWebhookEvent(projectId, workspaceId, 'model.saved', {
          modelId: (params as Record<string, unknown>).id as string,
          source: 'conversation',
        }).catch(() => {})
        break
      }

      case 'validate':
      case 'validate_schema': {
        // Schema validation from brain cache — comprehensive checks
        const brainData = await getOrBuildBrainCache(git, contentRoot, projectId)
        result = brainData.schemaValidation ?? {
          valid: null,
          warnings: [],
          healthScore: null,
          modelCount: brainData.models.size,
          validModels: 0,
          timestamp: new Date().toISOString(),
          unavailable: true,
        }
        break
      }

      case 'list_submissions': {
        const subModelId = params.modelId as string
        const subStatus = (params.status as string) ?? 'pending'
        const subLimit = Math.min(Number(params.limit ?? 20), 100)
        const subs = await useDatabaseProvider().listFormSubmissions(workspaceId, projectId, subModelId, { status: subStatus, limit: subLimit })
        result = subs.total > 0
          ? { submissions: subs.submissions, total: subs.total, message: agentMessage('forms.submission_list', { count: subs.total, status: subStatus }) }
          : { submissions: [], total: 0, message: agentMessage('forms.no_submissions') }
        break
      }

      case 'approve_submission': {
        const approveId = params.submissionId as string
        const dbp = useDatabaseProvider()
        const sub = await dbp.getFormSubmission(approveId)
        if (!sub || sub.workspace_id !== workspaceId || sub.project_id !== projectId) {
          result = { error: errorMessage('forms.submission_not_found') }
          break
        }

        // Create content entry in Git from submission data
        const { generateEntryId } = await import('@contentrain/types')
        const subModelId = sub.model_id as string
        const subData = sub.data as Record<string, unknown>
        const entryId = generateEntryId()
        const writeResult = await engine.saveContent(subModelId, 'en', { [entryId]: subData }, userEmail, { autoPublish })

        if (writeResult.branch) {
          if (shouldAutoMerge(workflow, permissions)) {
            await mergeForTool(engine, writeResult.branch, turnMerge)
          }
          invalidateBrainCache(projectId)
        }

        await dbp.updateFormSubmissionStatus(approveId, 'approved', userId, entryId)
        affected.snapshotChanged = true
        affected.branchesChanged = true
        affected.models.push(subModelId)
        result = { entryId, submission: { ...sub, status: 'approved', entry_id: entryId }, message: agentMessage('forms.approved') }
        break
      }

      case 'reject_submission': {
        const rejectId = params.submissionId as string
        const dbp = useDatabaseProvider()
        const sub = await dbp.getFormSubmission(rejectId)
        if (!sub || sub.workspace_id !== workspaceId || sub.project_id !== projectId) {
          result = { error: errorMessage('forms.submission_not_found') }
          break
        }
        const updated = await dbp.updateFormSubmissionStatus(rejectId, 'rejected')
        result = { submission: updated, message: agentMessage('forms.rejected') }
        break
      }

      case 'list_branches':
        result = { branches: await engine.listContentBranches() }
        break

      case 'merge_branch': {
        const branchToMerge = params.branch as string
        if (!branchToMerge.startsWith('cr/')) {
          result = { error: agentMessage('branch.contentrain_only_merge') }
          break
        }
        const mergeResult = await engine.mergeBranch(branchToMerge)
        affected.snapshotChanged = true
        affected.branchesChanged = true
        result = mergeResult

        // Emit webhook event (fire-and-forget)
        emitWebhookEvent(projectId, workspaceId, 'branch.merged', {
          branch: branchToMerge,
          source: 'conversation',
        }).catch(() => {})
        break
      }

      case 'reject_branch': {
        const branchToReject = params.branch as string
        if (branchToReject === 'contentrain') {
          result = { error: 'Cannot reject the permanent content branch' }
          break
        }
        if (!branchToReject.startsWith('cr/')) {
          result = { error: agentMessage('branch.contentrain_only_reject') }
          break
        }
        await engine.rejectBranch(branchToReject)
        affected.branchesChanged = true
        result = { rejected: true }

        // Emit webhook event (fire-and-forget)
        emitWebhookEvent(projectId, workspaceId, 'branch.rejected', {
          branch: branchToReject,
          source: 'conversation',
        }).catch(() => {})
        break
      }

      case 'copy_locale': {
        const copyModelId = params.model as string
        if (permissions.specificModels && !permissions.allowedModels.includes(copyModelId)) {
          result = { error: `${errorMessage('model.access_denied')}: ${copyModelId}` }
          break
        }
        const fromLocale = params.from as string
        const toLocale = params.to as string
        if (permissions.allowedLocales?.length) {
          if (!permissions.allowedLocales.includes(fromLocale)) {
            result = { error: `Locale "${fromLocale}" is not allowed for this API key` }
            break
          }
          if (!permissions.allowedLocales.includes(toLocale)) {
            result = { error: `Locale "${toLocale}" is not allowed for this API key` }
            break
          }
        }
        const writeResult = await engine.copyLocale(
          copyModelId, fromLocale, toLocale, userEmail,
        )
        if (!writeResult.validation.valid) {
          result = { error: writeResult.validation.errors.map(e => e.message).join(', ') }
          break
        }
        affected.models.push(params.model as string)
        affected.locales.push(params.to as string)
        affected.branchesChanged = true
        invalidateBrainCache(projectId)

        if (shouldAutoMerge(workflow, permissions)) {
          const mergeResult = await mergeForTool(engine, writeResult.branch, turnMerge)
          result = { ...summarizeWriteResult(writeResult), merged: mergeResult.merged }
        }
        else {
          result = { ...summarizeWriteResult(writeResult), merged: false, reviewBranch: writeResult.branch }
        }
        break
      }

      case 'init_project': {
        const initModels: ModelDefinition[] = []
        if (params.models && Array.isArray(params.models)) {
          for (const m of params.models as Record<string, unknown>[]) {
            initModels.push(m as unknown as ModelDefinition)
          }
        }
        const initResult = await engine.initProject(
          (params.stack as string) ?? 'other',
          (params.locales as string[]) ?? ['en'],
          (params.domains as string[]) ?? ['marketing'],
          initModels, userEmail,
        )
        affected.snapshotChanged = true
        affected.branchesChanged = true
        invalidateBrainCache(projectId)

        // Init always auto-merges
        const mergeResult = await engine.mergeBranch(initResult.branch)
        result = { ...summarizeWriteResult(initResult), merged: mergeResult.merged }
        break
      }

      case 'search_media': {
        const mediaProvider = useMediaProvider()
        if (!mediaProvider) {
          result = { error: errorMessage('media.storage_not_configured') }
          break
        }
        if (!hasFeature(plan, 'media.library')) {
          result = { error: errorMessage('media.library_upgrade', getUpgradeParams(plan)) }
          break
        }
        const searchResult = await mediaProvider.listAssets(projectId, {
          search: params.query as string | undefined,
          tags: params.tags as string[] | undefined,
          contentType: params.type as string | undefined,
          limit: Math.min((params.limit as number) ?? 10, 20),
        })
        result = searchResult.assets.map(a => ({
          id: a.id,
          filename: a.filename,
          path: a.originalPath,
          url: toDeliveryUrl(projectId, a.originalPath),
          alt: a.alt,
          tags: a.tags,
          dimensions: `${a.width}x${a.height}`,
          format: a.format,
          blurhash: a.blurhash,
          variants: Object.fromEntries(Object.entries(a.variants).map(([k, v]) => [k, v.path])),
        }))
        break
      }

      case 'upload_media': {
        const mediaProvider = useMediaProvider()
        if (!mediaProvider) {
          result = { error: errorMessage('media.storage_not_configured') }
          break
        }
        if (!hasFeature(plan, 'media.upload')) {
          result = { error: errorMessage('media.upload_upgrade', getUpgradeParams(plan)) }
          break
        }
        const url = params.url as string
        if (!url) {
          result = { error: agentMessage('media.url_required') }
          break
        }
        // SSRF guard — block internal/private/loopback targets, matching
        // the session URL-import route. Without this an agent prompt could
        // make the server fetch internal-only addresses.
        if (!isAllowedWebhookUrl(url)) {
          result = { error: agentMessage('media.url_blocked') }
          break
        }
        let fetchResponse: Response
        try {
          fetchResponse = await fetch(url, {
            headers: { 'User-Agent': 'Contentrain-Studio/1.0' },
            signal: AbortSignal.timeout(30_000),
          })
        }
        catch {
          result = { error: agentMessage('media.fetch_failed') }
          break
        }
        if (!fetchResponse.ok) {
          result = { error: agentMessage('media.url_bad_status', { status: fetchResponse.status }) }
          break
        }
        const mimeType = (fetchResponse.headers.get('content-type') ?? 'application/octet-stream').split(';')[0]!.trim()
        if (!isAllowedMimeType(mimeType)) {
          result = { error: agentMessage('media.type_not_allowed', { type: mimeType }) }
          break
        }
        const fileBuffer = Buffer.from(await fetchResponse.arrayBuffer())
        const urlFilename = new URL(url).pathname.split('/').pop() ?? 'uploaded-file'
        const variants = resolveVariantConfig(params.variants as string | undefined)

        const asset = await mediaProvider.upload({
          projectId,
          workspaceId,
          file: fileBuffer,
          filename: urlFilename,
          contentType: mimeType,
          alt: params.alt as string | undefined,
          tags: params.tags as string[] | undefined,
          variants,
          // uploaded_by is a uuid FK to profiles(id) — pass the user id, not the
          // email (the UI upload routes pass session.user.id). Passing the email
          // tripped "invalid input syntax for type uuid".
          uploadedBy: userId,
          source: 'agent',
        })
        result = {
          id: asset.id,
          path: asset.originalPath,
          url: toDeliveryUrl(projectId, asset.originalPath),
          filename: asset.filename,
          dimensions: `${asset.width}x${asset.height}`,
          variants: Object.fromEntries(Object.entries(asset.variants).map(([k, v]) => [k, v.path])),
        }
        break
      }

      case 'get_media': {
        const mediaProvider = useMediaProvider()
        if (!mediaProvider) {
          result = { error: errorMessage('media.storage_not_configured') }
          break
        }
        if (!hasFeature(plan, 'media.library')) {
          result = { error: errorMessage('media.library_upgrade', getUpgradeParams(plan)) }
          break
        }
        const asset = await mediaProvider.getAsset(params.assetId as string)
        if (!asset || asset.projectId !== projectId) {
          result = { error: agentMessage('media.asset_not_found') }
          break
        }
        result = withMediaUrls(projectId, asset)
        break
      }

      case 'update_status': {
        const modelId = params.model as string
        if (permissions.specificModels && !permissions.allowedModels.includes(modelId)) {
          result = { error: `${errorMessage('model.access_denied')}: ${modelId}` }
          break
        }
        const locale = (params.locale as string) ?? 'en'
        if (permissions.allowedLocales?.length && !permissions.allowedLocales.includes(locale)) {
          result = { error: `Locale "${locale}" is not allowed for this API key` }
          break
        }
        const status = params.status as string
        if (status !== 'draft' && status !== 'published' && status !== 'archived') {
          result = { error: agentMessage('content.invalid_status', { status: String(status) }) }
          break
        }
        const entryIds = Array.isArray(params.entryIds) ? params.entryIds as string[] : []
        if (entryIds.length === 0) {
          result = { error: agentMessage('content.no_entries') }
          break
        }
        const writeResult = await engine.updateEntryStatus(modelId, locale, entryIds, status, userEmail)
        if (!writeResult.validation.valid) {
          result = { error: writeResult.validation.errors.map(e => e.message).join(', ') }
          break
        }
        affected.models.push(modelId)
        affected.locales.push(locale)
        affected.branchesChanged = true
        invalidateBrainCache(projectId)
        if (shouldAutoMerge(workflow, permissions)) {
          const mergeResult = await mergeForTool(engine, writeResult.branch, turnMerge)
          result = { ...summarizeWriteResult(writeResult), merged: mergeResult.merged }
        }
        else {
          result = { ...summarizeWriteResult(writeResult), merged: false, reviewBranch: writeResult.branch }
        }
        break
      }

      case 'update_media': {
        const mediaProvider = useMediaProvider()
        if (!mediaProvider) {
          result = { error: errorMessage('media.storage_not_configured') }
          break
        }
        if (!hasFeature(plan, 'media.library')) {
          result = { error: errorMessage('media.library_upgrade', getUpgradeParams(plan)) }
          break
        }
        const asset = await mediaProvider.getAsset(params.assetId as string)
        if (!asset || asset.projectId !== projectId) {
          result = { error: agentMessage('media.asset_not_found') }
          break
        }
        const updated = await mediaProvider.updateMetadata(params.assetId as string, {
          alt: params.alt as string | undefined,
          tags: params.tags as string[] | undefined,
          focalPoint: params.focalPoint as { x: number, y: number } | undefined,
        })
        result = withMediaUrls(projectId, updated)
        break
      }

      case 'delete_media': {
        const mediaProvider = useMediaProvider()
        if (!mediaProvider) {
          result = { error: errorMessage('media.storage_not_configured') }
          break
        }
        if (!hasFeature(plan, 'media.library')) {
          result = { error: errorMessage('media.library_upgrade', getUpgradeParams(plan)) }
          break
        }
        const asset = await mediaProvider.getAsset(params.assetId as string)
        if (!asset || asset.projectId !== projectId) {
          result = { error: agentMessage('media.asset_not_found') }
          break
        }
        await mediaProvider.delete(projectId, params.assetId as string)
        result = { deleted: true, id: params.assetId }
        break
      }

      case 'branch_health': {
        const report = await checkBranchHealth(git, projectId, contentRoot)
        const limits = await resolveBranchLimits(git, contentRoot)
        result = {
          status: report.status,
          unmergedBranches: report.unmergedCount,
          warnLimit: limits.warn,
          blockLimit: limits.block,
        }
        break
      }

      case 'relation_expand': {
        const modelId = params.model as string
        if (permissions.specificModels && !permissions.allowedModels.includes(modelId)) {
          result = { error: `${errorMessage('model.access_denied')}: ${modelId}` }
          break
        }
        const brainData = await getOrBuildBrainCache(git, contentRoot, projectId)
        const locale = (params.locale as string) ?? uiContext.activeLocale ?? 'en'
        const entryRef = params.entryId as string
        const direction = (params.direction as string) === 'reverse' ? 'reverse' : 'forward'
        const expDefaultLocale = (brainData.config as { locales?: { default?: string } } | null)?.locales?.default ?? 'en'
        const viewFor = (m: string): ExpandModelView | undefined => {
          const def = brainData.models.get(m)
          if (!def?.fields) return undefined
          const data = brainData.content.get(`${m}:${locale}`) ?? brainData.content.get(`${m}:${expDefaultLocale}`)
          return { modelId: m, fields: def.fields, entries: brainRefEntries(data) }
        }
        if (direction === 'forward') {
          const view = viewFor(modelId)
          if (!view) {
            result = { error: errorMessage('content.not_found') }
            break
          }
          result = { direction, model: modelId, entryId: entryRef, relations: expandForward(view, entryRef, viewFor) }
        }
        else {
          const views = [...brainData.models.keys()].map(viewFor).filter((v): v is ExpandModelView => !!v)
          result = { direction, model: modelId, entryId: entryRef, referencedBy: expandReverse(modelId, entryRef, views) }
        }
        break
      }

      case 'vocabulary': {
        const action = (params.action as string) ?? 'get'
        if (action === 'get') {
          const brainData = await getOrBuildBrainCache(git, contentRoot, projectId)
          result = { vocabulary: brainData.vocabulary ?? {} }
          break
        }
        const terms = params.terms
        if (!terms || typeof terms !== 'object' || Array.isArray(terms)) {
          result = { error: agentMessage('vocabulary.terms_required') }
          break
        }
        const writeResult = await engine.saveVocabulary(terms as Record<string, Record<string, string>>, userEmail)
        if (!writeResult.validation.valid) {
          result = { error: writeResult.validation.errors.map(e => e.message).join(', ') }
          break
        }
        affected.snapshotChanged = true
        affected.branchesChanged = true
        invalidateBrainCache(projectId)
        if (shouldAutoMerge(workflow, permissions)) {
          const mergeResult = await mergeForTool(engine, writeResult.branch, turnMerge)
          result = { ...summarizeWriteResult(writeResult), merged: mergeResult.merged }
        }
        else {
          result = { ...summarizeWriteResult(writeResult), merged: false, reviewBranch: writeResult.branch }
        }
        break
      }

      case 'add_locale': {
        const newLocale = params.locale as string
        if (!newLocale) {
          result = { error: agentMessage('content.locale_required') }
          break
        }
        const writeResult = await engine.addLocale(newLocale, userEmail)
        if (!writeResult.validation.valid) {
          result = { error: writeResult.validation.errors.map(e => e.message).join(', ') }
          break
        }
        affected.snapshotChanged = true
        affected.branchesChanged = true
        invalidateBrainCache(projectId)
        if (shouldAutoMerge(workflow, permissions)) {
          const mergeResult = await mergeForTool(engine, writeResult.branch, turnMerge)
          result = { ...summarizeWriteResult(writeResult), merged: mergeResult.merged }
        }
        else {
          result = { ...summarizeWriteResult(writeResult), merged: false, reviewBranch: writeResult.branch }
        }
        break
      }

      case 'delete_model': {
        const modelId = params.model as string
        if (permissions.specificModels && !permissions.allowedModels.includes(modelId)) {
          result = { error: `${errorMessage('model.access_denied')}: ${modelId}` }
          break
        }

        // Inbound-reference safety: deleting a model that other content still
        // references would orphan those relations across the whole project, so
        // refuse and report what points at it (the user clears those first).
        // Mirrors the save-time relation-integrity guard at the model level.
        // Best-effort — only runs when the brain knows the model.
        const delBrain = await getOrBuildBrainCache(git, contentRoot, projectId)
        if (delBrain.models.has(modelId)) {
          const delViews: ExpandModelView[] = []
          const delTargetRefs = new Set<string>()
          for (const [key, data] of delBrain.content) {
            const m = key.slice(0, key.indexOf(':'))
            if (m === modelId) {
              for (const ref of brainRefEntries(data).keys()) delTargetRefs.add(ref)
              continue
            }
            const def = delBrain.models.get(m)
            if (def?.fields) delViews.push({ modelId: m, fields: def.fields, entries: brainRefEntries(data) })
          }
          const inbound = findInboundModelRefs(modelId, delTargetRefs, delViews)
          if (inbound.length > 0) {
            const list = inbound.slice(0, 10).map(r => `${r.model}.${r.ref} (${r.field})`).join(', ')
            result = { error: `${errorMessage('content.model_in_use')}: ${list}${inbound.length > 10 ? ` +${inbound.length - 10} more` : ''}` }
            break
          }
        }

        const writeResult = await engine.deleteModel(modelId, userEmail)
        if (!writeResult.validation.valid) {
          result = { error: writeResult.validation.errors.map(e => e.message).join(', ') }
          break
        }
        affected.models.push(modelId)
        affected.snapshotChanged = true
        affected.branchesChanged = true
        invalidateBrainCache(projectId)
        if (shouldAutoMerge(workflow, permissions)) {
          const mergeResult = await mergeForTool(engine, writeResult.branch, turnMerge)
          result = { ...summarizeWriteResult(writeResult), merged: mergeResult.merged }
        }
        else {
          result = { ...summarizeWriteResult(writeResult), merged: false, reviewBranch: writeResult.branch }
        }
        break
      }

      case 'brain_query': {
        const brainData = await getOrBuildBrainCache(git, contentRoot, projectId)
        const modelId = params.model as string
        if (permissions.specificModels && !permissions.allowedModels.includes(modelId)) {
          result = { error: `${errorMessage('model.access_denied')}: ${modelId}` }
          break
        }
        const locale = (params.locale as string) ?? uiContext.activeLocale ?? 'en'
        if (permissions.allowedLocales?.length && !permissions.allowedLocales.includes(locale)) {
          result = { error: `Locale "${locale}" is not allowed for this API key` }
          break
        }
        const key = `${modelId}:${locale}`
        const contentData = brainData.content.get(key) ?? null
        const metaData = brainData.meta.get(key) ?? null
        const modelDef = brainData.models.get(modelId)

        if (params.entryId && contentData && typeof contentData === 'object' && !Array.isArray(contentData)) {
          const entry = (contentData as Record<string, unknown>)[params.entryId as string]
          result = { modelId, locale, kind: modelDef?.kind ?? 'collection', data: entry ?? null, entryId: params.entryId }
        }
        else {
          result = { modelId, locale, kind: modelDef?.kind ?? 'collection', data: contentData, meta: metaData }
        }
        break
      }

      case 'brain_search': {
        const brainData = await getOrBuildBrainCache(git, contentRoot, projectId)
        const searchQuery = (params.query as string).toLowerCase()
        const targetModel = params.model as string | undefined
        const searchLimit = Math.min((params.limit as number) ?? 10, 50)

        const searchResults: Array<{ modelId: string, entryId: string, locale: string, preview: string }> = []

        for (const [key, data] of brainData.content) {
          const [mId, loc] = key.split(':')
          if (!mId || !loc) continue
          if (targetModel && mId !== targetModel) continue
          if (permissions.specificModels && !permissions.allowedModels.includes(mId)) continue
          if (permissions.allowedLocales?.length && !permissions.allowedLocales.includes(loc)) continue

          const stringified = JSON.stringify(data).toLowerCase()
          if (!stringified.includes(searchQuery)) continue

          if (typeof data === 'object' && data !== null && !Array.isArray(data)) {
            for (const [entryId, entry] of Object.entries(data as Record<string, unknown>)) {
              const entryStr = JSON.stringify(entry).toLowerCase()
              if (entryStr.includes(searchQuery)) {
                const preview = JSON.stringify(entry).substring(0, 200)
                searchResults.push({ modelId: mId, entryId, locale: loc, preview })
                if (searchResults.length >= searchLimit) break
              }
            }
          }
          else if (Array.isArray(data)) {
            for (const [idx, entry] of data.entries()) {
              const entryStr = JSON.stringify(entry).toLowerCase()
              if (entryStr.includes(searchQuery)) {
                const slug = typeof entry === 'object' && entry !== null ? (entry as Record<string, unknown>).slug as string ?? `entry-${idx}` : `entry-${idx}`
                searchResults.push({ modelId: mId, entryId: slug, locale: loc, preview: JSON.stringify(entry).substring(0, 200) })
                if (searchResults.length >= searchLimit) break
              }
            }
          }

          if (searchResults.length >= searchLimit) break
        }

        result = { query: params.query, results: searchResults, total: searchResults.length }
        break
      }

      case 'brain_analyze': {
        const brainData = await getOrBuildBrainCache(git, contentRoot, projectId)
        const analysisType = params.type as 'seo_audit' | 'locale_parity' | 'stale_content' | 'quality_score' | 'full'
        result = analyzeBrainContent(brainData, analysisType)
        break
      }

      default:
        result = { error: `Unknown tool: ${name}` }
    }

    // Invalidate brain cache after any write operation
    if (affected.snapshotChanged || affected.models.length > 0 || affected.branchesChanged) {
      invalidateBrainCache(projectId)
    }

    return { result, affected }
  }
  catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'Tool execution failed'
    return { result: { error: msg }, affected }
  }
}

// ─── Helpers ───

function summarizeWriteResult(result: { branch: string, commit: { sha: string }, diff: unknown[], validation: { valid: boolean, errors: Array<{ message: string }> } }): Record<string, unknown> {
  return {
    branch: result.branch,
    commitSha: result.commit.sha,
    filesChanged: result.diff.length,
    valid: result.validation.valid,
    errors: result.validation.errors.map(e => e.message),
  }
}

/**
 * Determine whether to auto-merge based on workflow config + user role.
 *
 * auto-merge workflow → always auto-merge
 * review workflow → Owner/Admin auto-merge (they're authorized), Editor → no merge (needs review)
 */
function shouldAutoMerge(workflow: string, permissions: AgentPermissions): boolean {
  if (workflow === 'auto-merge') return true
  // In review workflow, only Owner/Admin can auto-merge
  return permissions.workspaceRole === 'owner' || permissions.workspaceRole === 'admin'
}

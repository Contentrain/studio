import type { ModelDefinition, ContentrainConfig } from '@contentrain/types'
import type { AIMessage, AIContentBlock } from '~~/server/providers/ai'
import type { ChatRequest, AffectedResources } from '~~/server/utils/agent-types'
import type { AgentPermissions } from '~~/server/utils/agent-permissions'
import { createEventStream } from 'h3'
import { emptyAffected, mergeAffected, toAITools } from '~~/server/utils/agent-types'
import { deriveProjectPhase, checkStateTransition } from '~~/server/utils/agent-state-machine'
import { classifyIntent } from '~~/server/utils/agent-context'

/**
 * Chat SSE endpoint — Bounded Task Executor.
 *
 * Flow: context enrichment → state machine → intent → bounded prompt → tool loop → affected resources
 */

const MAX_TOOL_ITERATIONS = 5
const MAX_TOOL_RESULT_LENGTH = 2000
const HISTORY_TOKEN_BUDGET = 8000

export default defineEventHandler(async (event) => {
  const session = requireAuth(event)
  const workspaceId = getRouterParam(event, 'workspaceId')
  const projectId = getRouterParam(event, 'projectId')
  const body = await readBody<ChatRequest>(event)

  if (!workspaceId || !projectId || !body.message)
    throw createError({ statusCode: 400, message: 'workspaceId, projectId, and message are required' })

  // Default context if not provided (backward compat)
  const uiContext = body.context ?? {
    activeModelId: null,
    activeLocale: 'en',
    activeEntryId: null,
    panelState: 'overview' as const,
    activeBranch: null,
  }

  const client = useSupabaseUserClient(session.accessToken)
  const admin = useSupabaseAdmin()

  // === RESOLVE PROJECT + WORKSPACE ===
  const { project, workspace, git, contentRoot } = await resolveProjectContext(client, workspaceId, projectId)
  const plan = getWorkspacePlan(workspace)

  // === RATE LIMIT ===
  const rateKey = `chat:${session.user.id}`
  const rateCheck = checkRateLimit(rateKey)
  if (!rateCheck.allowed)
    throw createError({ statusCode: 429, message: `Rate limit exceeded. Try again in ${Math.ceil(rateCheck.retryAfterMs / 1000)}s` })

  // === MONTHLY LIMIT (aggregate across all sources: studio + byoa) ===
  const monthlyLimit = getMonthlyMessageLimit(plan)
  if (monthlyLimit !== Infinity) {
    const month = new Date().toISOString().substring(0, 7)
    const { data: usageRows } = await admin
      .from('agent_usage')
      .select('message_count')
      .eq('workspace_id', workspaceId)
      .eq('user_id', session.user.id)
      .eq('month', month)
    const totalCount = (usageRows ?? []).reduce((sum, r) => sum + (r.message_count ?? 0), 0)
    if (totalCount >= monthlyLimit)
      throw createError({ statusCode: 429, message: `Monthly message limit reached (${monthlyLimit} messages). Upgrade your plan for more.` })
  }

  // === PERMISSIONS ===
  const permissions = await resolveAgentPermissions(session.user.id, workspaceId, projectId, session.accessToken)
  if (permissions.availableTools.length === 0)
    throw createError({ statusCode: 403, message: 'No chat permissions' })

  // === API KEY (BYOA is ee/ feature — free uses studio key only) ===
  const runtimeConfig = useRuntimeConfig()
  let apiKey: string
  let usageSource: 'byoa' | 'studio' = 'studio'

  if (hasFeature(plan, 'ai.byoa')) {
    const encryptedByoaKey = await getBYOAKey(client, workspaceId, session.user.id)
    if (encryptedByoaKey) {
      apiKey = decryptApiKey(encryptedByoaKey, runtimeConfig.sessionSecret)
      usageSource = 'byoa'
    }
    else if (runtimeConfig.anthropic.apiKey) {
      apiKey = runtimeConfig.anthropic.apiKey
    }
    else {
      throw createError({ statusCode: 400, message: 'No API key configured.' })
    }
  }
  else if (runtimeConfig.anthropic.apiKey) {
    apiKey = runtimeConfig.anthropic.apiKey
  }
  else {
    throw createError({ statusCode: 400, message: 'No API key configured.' })
  }

  // === CONVERSATION ===
  let conversationId: string | undefined = body.conversationId

  // Verify ownership if continuing existing conversation
  if (conversationId) {
    const { data: conv } = await client
      .from('conversations')
      .select('id')
      .eq('id', conversationId)
      .eq('user_id', session.user.id)
      .eq('project_id', projectId)
      .single()
    if (!conv) {
      // Invalid or foreign conversation — start fresh
      conversationId = undefined
    }
  }

  if (!conversationId) {
    conversationId = (await createConversation(client, projectId, session.user.id, body.message)) ?? undefined
  }
  if (!conversationId)
    throw createError({ statusCode: 500, message: 'Failed to create conversation' })

  // === HISTORY ===
  const historyRows = await loadConversationHistory(client, conversationId, 50)

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
    const content = row.tool_calls ? (row.tool_calls as AIContentBlock[]) : row.content
    messages.push({ role: row.role as 'user' | 'assistant', content })
  }
  messages.push({ role: 'user', content: body.message })

  // === LOAD SCHEMA ===
  let projectConfig: ContentrainConfig | null = null
  const models: ModelDefinition[] = []
  let vocabulary: Record<string, Record<string, string>> | null = null

  try {
    const cfgPath = contentRoot ? `${contentRoot}/.contentrain/config.json` : '.contentrain/config.json'
    projectConfig = JSON.parse(await git.readFile(cfgPath)) as ContentrainConfig
  }
  catch { /* no config */ }

  try {
    const mdDir = contentRoot ? `${contentRoot}/.contentrain/models` : '.contentrain/models'
    const modelFiles = await git.listDirectory(mdDir)
    for (const file of modelFiles) {
      if (!file.endsWith('.json')) continue
      try {
        models.push(JSON.parse(await git.readFile(`${mdDir}/${file}`)) as ModelDefinition)
      }
      catch { /* skip */ }
    }
  }
  catch { /* no models */ }

  // Load vocabulary + context from .contentrain/
  let contentContext: Record<string, unknown> | null = null
  try {
    const vocabPath = contentRoot ? `${contentRoot}/.contentrain/vocabulary.json` : '.contentrain/vocabulary.json'
    const vocabData = JSON.parse(await git.readFile(vocabPath)) as { terms?: Record<string, Record<string, string>> }
    vocabulary = vocabData.terms ?? null
  }
  catch { /* no vocabulary */ }

  try {
    const ctxPath = contentRoot ? `${contentRoot}/.contentrain/context.json` : '.contentrain/context.json'
    contentContext = JSON.parse(await git.readFile(ctxPath)) as Record<string, unknown>
  }
  catch { /* no context */ }

  // === STATE MACHINE ===
  let pendingBranches: Array<{ name: string, sha: string, protected: boolean }> = []
  try {
    pendingBranches = await git.listBranches('contentrain/')
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

  const systemPrompt = buildSystemPrompt(projectConfig, models, permissions, projectState, uiContext, intent, vocabulary, plan)

  // === FILTER TOOLS by permissions + phase ===
  const permissionFiltered = filterToolsByPermissions(STUDIO_TOOLS, permissions.availableTools) as StudioTool[]
  const phaseFiltered = permissionFiltered.filter(t => t.requiredPhase.includes(phase))
  const aiTools = toAITools(phaseFiltered)

  // Model: plan-gated selection
  const ALL_MODELS = ['claude-sonnet-4-20250514', 'claude-opus-4-20250514', 'claude-haiku-4-5-20251001']
  const FREE_MODELS = ['claude-haiku-4-5-20251001']
  const availableModels = hasFeature(plan, 'ai.studio_key') ? ALL_MODELS : FREE_MODELS
  const requestedModel = body.model as string | undefined
  const model = (requestedModel && availableModels.includes(requestedModel)) ? requestedModel : availableModels[0]!

  // Workflow: free plan always auto-merges regardless of config
  const configWorkflow = projectConfig?.workflow ?? 'auto-merge'
  const workflow = hasFeature(plan, 'workflow.review') ? configWorkflow : 'auto-merge'

  // === SSE STREAM ===
  const eventStream = createEventStream(event)
  const contentEngine = createContentEngine({ git, contentRoot })
  const aiProvider = useAIProvider()

  const processChat = async () => {
    await eventStream.push(JSON.stringify({ type: 'conversation', id: conversationId }))

    let totalInputTokens = 0
    let totalOutputTokens = 0
    let lastAssistantContent: AIContentBlock[] = []
    let accumulatedAffected: AffectedResources = emptyAffected()

    try {
      let iteration = 0

      while (iteration < MAX_TOOL_ITERATIONS) {
        iteration++
        const isFirstIteration = iteration === 1
        const currentToolCalls: Array<{ id: string, name: string, input: unknown }> = []
        let stopReason: string | undefined

        if (isFirstIteration) {
          for await (const streamEvent of aiProvider.streamCompletion(
            { model, system: systemPrompt, messages, tools: aiTools, maxTokens: 4096 },
            apiKey,
          )) {
            switch (streamEvent.type) {
              case 'text':
                await eventStream.push(JSON.stringify({ type: 'text', content: streamEvent.content }))
                break
              case 'tool_use_start':
                await eventStream.push(JSON.stringify({ type: 'tool_use', id: streamEvent.toolId, name: streamEvent.toolName }))
                break
              case 'tool_use_end':
                currentToolCalls.push({
                  id: streamEvent.toolId!,
                  name: streamEvent.toolName!,
                  input: (typeof streamEvent.toolInput === 'object' && streamEvent.toolInput !== null) ? streamEvent.toolInput : {},
                })
                break
              case 'message_end':
                totalInputTokens += streamEvent.usage?.inputTokens ?? 0
                totalOutputTokens += streamEvent.usage?.outputTokens ?? 0
                stopReason = streamEvent.stopReason
                break
              case 'error':
                await eventStream.push(JSON.stringify({ type: 'error', message: streamEvent.error }))
                break
            }
          }
        }
        else {
          const response = await aiProvider.createCompletion(
            { model, system: systemPrompt, messages, tools: aiTools, maxTokens: 2048 },
            apiKey,
          )
          totalInputTokens += response.usage.inputTokens
          totalOutputTokens += response.usage.outputTokens
          stopReason = response.stopReason

          for (const block of response.content) {
            if (block.type === 'text') {
              await eventStream.push(JSON.stringify({ type: 'text', content: block.text }))
            }
            else if (block.type === 'tool_use') {
              await eventStream.push(JSON.stringify({ type: 'tool_use', id: block.id, name: block.name }))
              currentToolCalls.push({
                id: block.id,
                name: block.name,
                input: (typeof block.input === 'object' && block.input !== null) ? block.input : {},
              })
            }
          }
          lastAssistantContent = response.content
        }

        if (stopReason !== 'tool_use' || currentToolCalls.length === 0) break

        // === TOOL EXECUTION with state guard + workflow-aware auto-merge ===
        const assistantBlocks: AIContentBlock[] = currentToolCalls.map(tc => ({
          type: 'tool_use' as const,
          id: tc.id,
          name: tc.name,
          input: tc.input,
        }))

        const toolResultBlocks: AIContentBlock[] = []

        for (const tc of currentToolCalls) {
          // State machine guard
          const stateCheck = checkStateTransition(phase, tc.name)
          if (!stateCheck.allowed) {
            const errorResult = { error: stateCheck.reason, suggestion: stateCheck.suggestion }
            await eventStream.push(JSON.stringify({ type: 'tool_result', id: tc.id, name: tc.name, result: errorResult }))
            toolResultBlocks.push({ type: 'tool_result', toolUseId: tc.id, content: JSON.stringify(errorResult) })
            continue
          }

          // Execute tool
          const result = await executeToolWithAutoMerge(
            tc.name, tc.input, contentEngine, git, session.user.email ?? '', contentRoot, workflow, permissions, plan,
          )

          // Accumulate affected resources
          accumulatedAffected = mergeAffected(accumulatedAffected, result.affected)

          // Truncate for context
          let resultStr = JSON.stringify(result.result)
          if (resultStr.length > MAX_TOOL_RESULT_LENGTH) {
            resultStr = resultStr.substring(0, MAX_TOOL_RESULT_LENGTH) + '...(truncated)'
          }

          await eventStream.push(JSON.stringify({ type: 'tool_result', id: tc.id, name: tc.name, result: result.result }))
          toolResultBlocks.push({ type: 'tool_result', toolUseId: tc.id, content: resultStr })
        }

        messages.push({ role: 'assistant', content: assistantBlocks })
        messages.push({ role: 'user', content: toolResultBlocks })
        lastAssistantContent = assistantBlocks
      }

      // === DONE with affected resources ===
      await eventStream.push(JSON.stringify({
        type: 'done',
        usage: { inputTokens: totalInputTokens, outputTokens: totalOutputTokens },
        affected: accumulatedAffected,
      }))

      // === SAVE TO DB ===
      const assistantText = lastAssistantContent
        .filter(b => b.type === 'text')
        .map(b => (b as { text: string }).text)
        .join('')

      await saveChatResult(
        admin, conversationId, body.message, assistantText,
        lastAssistantContent, model, totalInputTokens, totalOutputTokens,
        workspaceId, session.user.id, usageSource,
      )
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
  eventStream.onClosed(() => { /* client disconnected */ })
  return eventStream.send()
})

/**
 * Execute tool with workflow-aware auto-merge and affected resources.
 */
async function executeToolWithAutoMerge(
  name: string,
  input: unknown,
  engine: ReturnType<typeof createContentEngine>,
  git: ReturnType<typeof useGitProvider>,
  userEmail: string,
  contentRoot: string,
  workflow: string,
  permissions: AgentPermissions,
  plan: string,
): Promise<{ result: unknown, affected: AffectedResources }> {
  const params = (input ?? {}) as Record<string, unknown>
  const affected: AffectedResources = emptyAffected()
  // Free plan: auto-publish on save. Pro+: draft (user publishes manually or via review merge)
  const autoPublish = plan === 'free'

  try {
    let result: unknown

    switch (name) {
      case 'list_models': {
        const modelsDir = contentRoot ? `${contentRoot}/.contentrain/models` : '.contentrain/models'
        const files = await git.listDirectory(modelsDir)
        const modelsList = []
        for (const file of files) {
          if (!file.endsWith('.json')) continue
          try {
            modelsList.push(JSON.parse(await git.readFile(`${modelsDir}/${file}`)))
          }
          catch { /* skip */ }
        }
        result = { models: modelsList }
        break
      }

      case 'get_content': {
        const modelId = params.model as string
        // Model-scope enforcement (not just prompt-level)
        if (permissions.specificModels && !permissions.allowedModels.includes(modelId)) {
          result = { error: `Access denied: model "${modelId}" is not in your allowed models` }
          break
        }
        const locale = (params.locale as string) ?? 'en'
        const modelsDir = contentRoot ? `${contentRoot}/.contentrain/models` : '.contentrain/models'
        const modelDef = JSON.parse(await git.readFile(`${modelsDir}/${modelId}.json`)) as ModelDefinition
        const pathCtx = { contentRoot }

        // Load meta (status, source, updated_by)
        let meta: Record<string, unknown> | null = null
        try {
          const metaPath = resolveMetaPath(pathCtx, modelDef, locale)
          meta = JSON.parse(await git.readFile(metaPath)) as Record<string, unknown>
        }
        catch { /* no meta */ }

        // Document kind: read markdown files
        if (modelDef.kind === 'document') {
          try {
            const contentDir = resolveContentPath(pathCtx, modelDef, locale)
            // contentDir is the base directory for documents; list slug directories
            const basePath = contentDir.replace(`/${locale}.md`, '')
            const slugDirs = await git.listDirectory(basePath)
            const documents: Array<{ slug: string, frontmatter: Record<string, unknown>, body: string }> = []
            for (const slug of slugDirs) {
              try {
                const mdPath = `${basePath}/${slug}/${locale}.md`
                const raw = await git.readFile(mdPath)
                const { frontmatter, body } = parseMarkdownFrontmatter(raw)
                documents.push({ slug, frontmatter, body: body.substring(0, 500) })
              }
              catch { /* skip */ }
            }
            result = { modelId, locale, kind: 'document', data: documents, meta }
          }
          catch {
            result = { modelId, locale, kind: 'document', data: [], meta, error: 'Content not found' }
          }
          break
        }

        // JSON kinds (collection, singleton, dictionary)
        const contentPath = resolveContentPath(pathCtx, modelDef, locale)
        try {
          let data = JSON.parse(await git.readFile(contentPath))
          // Normalize array → object-map for collections
          if (modelDef.kind === 'collection' && Array.isArray(data)) {
            const map: Record<string, unknown> = {}
            for (let i = 0; i < data.length; i++) {
              const entry = data[i] as Record<string, unknown>
              const id = String(entry.id ?? entry.ID ?? `entry-${i}`)
              const { id: _id, ID: _ID, ...fields } = entry
              map[id] = fields
            }
            data = map
          }
          if (typeof data === 'object' && !Array.isArray(data) && Object.keys(data).length > 10) {
            const keys = Object.keys(data)
            const sample = Object.fromEntries(keys.slice(0, 5).map(k => [k, (data as Record<string, unknown>)[k]]))
            result = { modelId, locale, kind: modelDef.kind, totalEntries: keys.length, sample, meta, note: `Showing 5 of ${keys.length}` }
          }
          else {
            result = { modelId, locale, kind: modelDef.kind, data, meta }
          }
        }
        catch {
          result = { modelId, locale, kind: modelDef.kind, data: null, meta, error: 'Content not found' }
        }
        break
      }

      case 'save_content': {
        const modelId = params.model as string
        if (permissions.specificModels && !permissions.allowedModels.includes(modelId)) {
          result = { error: `Access denied: model "${modelId}" is not in your allowed models` }
          break
        }
        const locale = (params.locale as string) ?? 'en'
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

        affected.models.push(modelId)
        affected.locales.push(locale)
        affected.branchesChanged = true

        // Role-aware auto-merge
        if (shouldAutoMerge(workflow, permissions) && writeResult.branch) {
          const mergeResult = await engine.mergeBranch(writeResult.branch)
          result = { ...summarizeWriteResult(writeResult), merged: mergeResult.merged, workflow }
        }
        else if (writeResult.branch) {
          result = { ...summarizeWriteResult(writeResult), merged: false, workflow, reviewBranch: writeResult.branch }
        }
        else {
          result = { ...summarizeWriteResult(writeResult), merged: false, workflow }
        }
        break
      }

      case 'delete_content': {
        const modelId = params.model as string
        const locale = (params.locale as string) ?? 'en'
        const writeResult = await engine.deleteContent(modelId, locale, params.entryIds as string[], userEmail)
        affected.models.push(modelId)
        affected.locales.push(locale)
        affected.branchesChanged = true

        if (shouldAutoMerge(workflow, permissions)) {
          const mergeResult = await engine.mergeBranch(writeResult.branch)
          result = { ...summarizeWriteResult(writeResult), merged: mergeResult.merged }
        }
        else {
          result = { ...summarizeWriteResult(writeResult), merged: false, reviewBranch: writeResult.branch }
        }
        break
      }

      case 'save_model': {
        const writeResult = await engine.saveModel(params as unknown as ModelDefinition, userEmail)
        affected.snapshotChanged = true
        affected.branchesChanged = true

        if (shouldAutoMerge(workflow, permissions)) {
          const mergeResult = await engine.mergeBranch(writeResult.branch)
          result = { ...summarizeWriteResult(writeResult), merged: mergeResult.merged }
        }
        else {
          result = { ...summarizeWriteResult(writeResult), merged: false, reviewBranch: writeResult.branch }
        }
        break
      }

      case 'validate': {
        // Basic validation: check that models have content files
        const valModelsDir = contentRoot ? `${contentRoot}/.contentrain/models` : '.contentrain/models'
        const valErrors: string[] = []
        try {
          const valFiles = await git.listDirectory(valModelsDir)
          for (const file of valFiles) {
            if (!file.endsWith('.json')) continue
            try {
              const def = JSON.parse(await git.readFile(`${valModelsDir}/${file}`)) as ModelDefinition
              if (def.kind !== 'document') {
                const valPathCtx = { contentRoot }
                const contentPath = resolveContentPath(valPathCtx, def, def.i18n ? 'en' : 'data')
                try {
                  await git.readFile(contentPath)
                }
                catch {
                  valErrors.push(`Model "${def.id}": content file missing at ${contentPath}`)
                }
              }
            }
            catch { /* skip invalid model file */ }
          }
        }
        catch {
          valErrors.push('Models directory not found')
        }
        result = { valid: valErrors.length === 0, errors: valErrors }
        break
      }

      case 'list_branches':
        result = { branches: await engine.listContentBranches() }
        break

      case 'merge_branch': {
        const branchToMerge = params.branch as string
        if (!branchToMerge.startsWith('contentrain/')) {
          result = { error: 'Only contentrain/ branches can be merged' }
          break
        }
        const mergeResult = await engine.mergeBranch(branchToMerge)
        affected.snapshotChanged = true
        affected.branchesChanged = true
        result = mergeResult
        break
      }

      case 'reject_branch': {
        const branchToReject = params.branch as string
        if (!branchToReject.startsWith('contentrain/')) {
          result = { error: 'Only contentrain/ branches can be rejected' }
          break
        }
        await engine.rejectBranch(branchToReject)
        affected.branchesChanged = true
        result = { rejected: true }
        break
      }

      case 'copy_locale': {
        const writeResult = await engine.copyLocale(
          params.model as string, params.from as string, params.to as string, userEmail,
        )
        if (!writeResult.validation.valid) {
          result = { error: writeResult.validation.errors.map(e => e.message).join(', ') }
          break
        }
        affected.models.push(params.model as string)
        affected.locales.push(params.to as string)
        affected.branchesChanged = true

        if (shouldAutoMerge(workflow, permissions)) {
          const mergeResult = await engine.mergeBranch(writeResult.branch)
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

        // Init always auto-merges
        const mergeResult = await engine.mergeBranch(initResult.branch)
        result = { ...summarizeWriteResult(initResult), merged: mergeResult.merged }
        break
      }

      default:
        result = { error: `Unknown tool: ${name}` }
    }

    return { result, affected }
  }
  catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'Tool execution failed'
    return { result: { error: msg }, affected }
  }
}

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

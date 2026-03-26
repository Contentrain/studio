import type { ModelDefinition } from '@contentrain/types'
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
    throw createError({ statusCode: 400, message: errorMessage('validation.message_required') })

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
    throw createError({ statusCode: 429, message: errorMessage('chat.rate_limited', { seconds: Math.ceil(rateCheck.retryAfterMs / 1000) }) })

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
      throw createError({ statusCode: 429, message: errorMessage('chat.monthly_limit_reached', { limit: monthlyLimit }) })
  }

  // === PERMISSIONS ===
  const permissions = await resolveAgentPermissions(session.user.id, workspaceId, projectId, session.accessToken)
  if (permissions.availableTools.length === 0)
    throw createError({ statusCode: 403, message: errorMessage('chat.no_permissions') })

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
      throw createError({ statusCode: 400, message: errorMessage('chat.no_api_key') })
    }
  }
  else if (runtimeConfig.anthropic.apiKey) {
    apiKey = runtimeConfig.anthropic.apiKey
  }
  else {
    throw createError({ statusCode: 400, message: errorMessage('chat.no_api_key') })
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
    throw createError({ statusCode: 500, message: errorMessage('chat.conversation_create_failed') })

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

  // === LOAD SCHEMA (from brain cache) ===
  const brain = await getOrBuildBrainCache(git, contentRoot, projectId)
  const projectConfig = brain.config
  const models = [...brain.models.values()]
  const vocabulary = brain.vocabulary
  const contentContext = brain.contentContext

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
            tc.name, tc.input, contentEngine, git, session.user.email ?? '', contentRoot, workflow, permissions, plan, projectId, workspaceId, uiContext,
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
  projectId: string,
  workspaceId: string,
  uiContext: import('~~/server/utils/agent-types').ChatUIContext,
): Promise<{ result: unknown, affected: AffectedResources }> {
  const params = (input ?? {}) as Record<string, unknown>
  const affected: AffectedResources = emptyAffected()
  // Free plan: auto-publish on save. Pro+: draft (user publishes manually or via review merge)
  const autoPublish = plan === 'free'

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
        invalidateBrainCache(projectId)

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
        invalidateBrainCache(projectId)

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
        invalidateBrainCache(projectId)

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
          result = { error: agentMessage('branch.contentrain_only_merge') }
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
          result = { error: agentMessage('branch.contentrain_only_reject') }
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
        invalidateBrainCache(projectId)

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
          result = { error: errorMessage('media.library_upgrade') }
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
          result = { error: errorMessage('media.upload_upgrade') }
          break
        }
        const url = params.url as string
        if (!url) {
          result = { error: agentMessage('media.url_required') }
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
          uploadedBy: userEmail,
          source: 'agent',
        })
        result = {
          id: asset.id,
          path: asset.originalPath,
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
          result = { error: errorMessage('media.library_upgrade') }
          break
        }
        const asset = await mediaProvider.getAsset(params.assetId as string)
        if (!asset || asset.projectId !== projectId) {
          result = { error: agentMessage('media.asset_not_found') }
          break
        }
        result = asset
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

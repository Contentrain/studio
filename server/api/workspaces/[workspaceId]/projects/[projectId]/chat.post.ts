import type { ModelDefinition, ContentrainConfig } from '@contentrain/types'
import type { AIMessage, AIContentBlock } from '~~/server/providers/ai'
import type { ChatRequest, AffectedResources } from '~~/server/utils/agent-types'
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
  const { data: project } = await client
    .from('projects')
    .select('repo_full_name, content_root, workspace_id, status')
    .eq('id', projectId)
    .eq('workspace_id', workspaceId)
    .single()

  if (!project)
    throw createError({ statusCode: 404, message: 'Project not found' })

  const { data: workspace } = await client
    .from('workspaces')
    .select('github_installation_id, plan')
    .eq('id', workspaceId)
    .single()

  if (!workspace?.github_installation_id)
    throw createError({ statusCode: 400, message: 'GitHub App not installed' })

  // === PERMISSIONS ===
  const permissions = await resolveAgentPermissions(session.user.id, workspaceId, projectId, session.accessToken)
  if (permissions.availableTools.length === 0)
    throw createError({ statusCode: 403, message: 'No chat permissions' })

  // === API KEY ===
  const runtimeConfig = useRuntimeConfig()
  let apiKey: string
  let usageSource: 'byoa' | 'studio' = 'studio'

  const { data: byoaKey } = await client
    .from('ai_keys')
    .select('encrypted_key')
    .eq('workspace_id', workspaceId)
    .eq('user_id', session.user.id)
    .eq('provider', 'anthropic')
    .single()

  if (byoaKey?.encrypted_key) {
    apiKey = decryptApiKey(byoaKey.encrypted_key, runtimeConfig.sessionSecret)
    usageSource = 'byoa'
  }
  else if (runtimeConfig.anthropic.apiKey) {
    apiKey = runtimeConfig.anthropic.apiKey
  }
  else {
    throw createError({ statusCode: 400, message: 'No API key configured.' })
  }

  // === CONVERSATION ===
  let conversationId = body.conversationId
  if (!conversationId) {
    const { data: conv } = await client
      .from('conversations')
      .insert({ project_id: projectId, user_id: session.user.id, title: body.message.substring(0, 100) })
      .select('id')
      .single()
    conversationId = conv?.id
  }
  if (!conversationId)
    throw createError({ statusCode: 500, message: 'Failed to create conversation' })

  // === HISTORY ===
  const { data: historyRows } = await client
    .from('messages')
    .select('role, content, tool_calls')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: false })
    .limit(50)

  const allHistory = (historyRows ?? []).reverse()
  const messages: AIMessage[] = []
  let historyTokens = 0

  for (const row of allHistory) {
    const content = row.tool_calls ? (row.tool_calls as AIContentBlock[]) : row.content
    const tokenEstimate = typeof content === 'string' ? Math.ceil(content.length / 4) : Math.ceil(JSON.stringify(content).length / 4)
    if (historyTokens + tokenEstimate > HISTORY_TOKEN_BUDGET) break
    messages.push({ role: row.role as 'user' | 'assistant', content })
    historyTokens += tokenEstimate
  }
  messages.push({ role: 'user', content: body.message })

  // === LOAD SCHEMA ===
  const [owner, repo] = project.repo_full_name.split('/')
  const git = useGitProvider({ installationId: workspace.github_installation_id, owner, repo })
  const contentRoot = normalizeContentRoot(project.content_root)

  let projectConfig: ContentrainConfig | null = null
  const models: ModelDefinition[] = []

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

  // === STATE MACHINE ===
  let pendingBranches: Array<{ name: string, sha: string, protected: boolean }> = []
  try {
    pendingBranches = await git.listBranches('contentrain/')
  }
  catch { /* no branches */ }

  const phase = deriveProjectPhase(projectConfig, pendingBranches, project.status)

  // === INTENT CLASSIFICATION ===
  const intent = classifyIntent(body.message, uiContext, phase)

  // === BUILD SYSTEM PROMPT (bounded, context-aware) ===
  const projectState = {
    initialized: !!projectConfig,
    pendingBranches,
    projectStatus: project.status,
    phase,
  }

  const systemPrompt = buildSystemPrompt(projectConfig, models, permissions, projectState, uiContext, intent)

  // === FILTER TOOLS by permissions + phase ===
  const permissionFiltered = filterToolsByPermissions(STUDIO_TOOLS, permissions.availableTools) as StudioTool[]
  const phaseFiltered = permissionFiltered.filter(t => t.requiredPhase.includes(phase))
  const aiTools = toAITools(phaseFiltered)

  const model = 'claude-sonnet-4-20250514'
  const workflow = projectConfig?.workflow ?? 'auto-merge'

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
            tc.name, tc.input, contentEngine, git, session.user.email ?? '', workflow,
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
      await admin.from('messages').insert({ conversation_id: conversationId, role: 'user', content: body.message })

      const assistantText = lastAssistantContent
        .filter(b => b.type === 'text')
        .map(b => (b as { text: string }).text)
        .join('')

      await admin.from('messages').insert({
        conversation_id: conversationId,
        role: 'assistant',
        content: assistantText || '[tool calls]',
        tool_calls: lastAssistantContent.length > 0 ? lastAssistantContent : null,
        token_count_input: totalInputTokens,
        token_count_output: totalOutputTokens,
        model,
      })

      const month = new Date().toISOString().substring(0, 7)
      await admin.from('agent_usage').upsert({
        workspace_id: workspaceId,
        user_id: session.user.id,
        month,
        source: usageSource,
        message_count: 1,
        input_tokens: totalInputTokens,
        output_tokens: totalOutputTokens,
      }, { onConflict: 'workspace_id,user_id,month,source' })

      await admin.from('conversations').update({ updated_at: new Date().toISOString() }).eq('id', conversationId)
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
  workflow: string,
): Promise<{ result: unknown, affected: AffectedResources }> {
  const params = (input ?? {}) as Record<string, unknown>
  const affected: AffectedResources = emptyAffected()

  try {
    let result: unknown

    switch (name) {
      case 'list_models': {
        const modelsDir = '.contentrain/models'
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
        const locale = (params.locale as string) ?? 'en'
        const modelsDir = '.contentrain/models'
        const modelDef = JSON.parse(await git.readFile(`${modelsDir}/${modelId}.json`)) as ModelDefinition
        const contentPath = resolveContentPath({ contentRoot: '' }, modelDef, locale)
        try {
          let data = JSON.parse(await git.readFile(contentPath))
          // Normalize array → object-map for collections so agent sees entry IDs as keys
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
            result = { modelId, locale, totalEntries: keys.length, sample, note: `Showing 5 of ${keys.length}` }
          }
          else {
            result = { modelId, locale, data }
          }
        }
        catch {
          result = { modelId, locale, data: null, error: 'Content not found' }
        }
        break
      }

      case 'save_content': {
        const modelId = params.model as string
        const locale = (params.locale as string) ?? 'en'
        const writeResult = await engine.saveContent(modelId, locale, params.data as Record<string, unknown>, userEmail)
        affected.models.push(modelId)
        affected.locales.push(locale)
        affected.branchesChanged = true

        // Workflow-aware auto-merge
        if (workflow === 'auto-merge') {
          const mergeResult = await engine.mergeBranch(writeResult.branch)
          result = { ...summarizeWriteResult(writeResult), merged: mergeResult.merged, workflow }
        }
        else {
          result = { ...summarizeWriteResult(writeResult), merged: false, workflow, reviewBranch: writeResult.branch }
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

        if (workflow === 'auto-merge') {
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

        if (workflow === 'auto-merge') {
          const mergeResult = await engine.mergeBranch(writeResult.branch)
          result = { ...summarizeWriteResult(writeResult), merged: mergeResult.merged }
        }
        else {
          result = { ...summarizeWriteResult(writeResult), merged: false, reviewBranch: writeResult.branch }
        }
        break
      }

      case 'validate':
        result = { valid: true, errors: [] }
        break

      case 'list_branches':
        result = { branches: await engine.listContentBranches() }
        break

      case 'merge_branch': {
        const mergeResult = await engine.mergeBranch(params.branch as string)
        affected.snapshotChanged = true
        affected.branchesChanged = true
        result = mergeResult
        break
      }

      case 'reject_branch':
        await engine.rejectBranch(params.branch as string)
        affected.branchesChanged = true
        result = { rejected: true }
        break

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

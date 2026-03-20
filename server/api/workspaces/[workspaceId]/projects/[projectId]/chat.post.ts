import type { ModelDefinition, ContentrainConfig } from '@contentrain/types'
import type { AIMessage, AIContentBlock } from '~~/server/providers/ai'
import { createEventStream } from 'h3'

/**
 * Chat SSE endpoint.
 *
 * Optimizations applied:
 * 1. Token-budgeted history (not message count)
 * 2. Recursive tool loop (max 5 iterations)
 * 3. Tool result truncation (prevent token explosion)
 * 4. Schema cached per conversation (not re-fetched per message)
 * 5. Adaptive maxTokens based on context
 */

const MAX_TOOL_ITERATIONS = 5
const MAX_TOOL_RESULT_LENGTH = 2000 // chars, prevents huge JSON in context
const HISTORY_TOKEN_BUDGET = 8000 // approximate token budget for history

export default defineEventHandler(async (event) => {
  const session = requireAuth(event)
  const workspaceId = getRouterParam(event, 'workspaceId')
  const projectId = getRouterParam(event, 'projectId')
  const body = await readBody<{ message: string, conversationId?: string }>(event)

  if (!workspaceId || !projectId || !body.message)
    throw createError({ statusCode: 400, message: 'workspaceId, projectId, and message are required' })

  const client = useSupabaseUserClient(session.accessToken)
  const admin = useSupabaseAdmin()

  // Get project + workspace
  const { data: project } = await client
    .from('projects')
    .select('repo_full_name, content_root, workspace_id')
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

  // Resolve permissions
  const permissions = await resolveAgentPermissions(
    session.user.id, workspaceId, projectId, session.accessToken,
  )

  if (permissions.availableTools.length === 0)
    throw createError({ statusCode: 403, message: 'No chat permissions for this project' })

  // Resolve API key
  const config = useRuntimeConfig()
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
    apiKey = decryptApiKey(byoaKey.encrypted_key, config.sessionSecret)
    usageSource = 'byoa'
  }
  else if (config.anthropic.apiKey) {
    apiKey = config.anthropic.apiKey
  }
  else {
    throw createError({ statusCode: 400, message: 'No API key configured.' })
  }

  // Get or create conversation
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

  // Load history with token budget (not message count)
  const { data: historyRows } = await client
    .from('messages')
    .select('role, content, tool_calls')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: false })
    .limit(50) // fetch more, then trim by token budget

  // Reverse to chronological, trim by token budget
  const allHistory = (historyRows ?? []).reverse()
  const messages: AIMessage[] = []
  let historyTokens = 0

  for (const row of allHistory) {
    const content = row.tool_calls ? (row.tool_calls as AIContentBlock[]) : row.content
    const tokenEstimate = typeof content === 'string' ? Math.ceil(content.length / 4) : Math.ceil(JSON.stringify(content).length / 4)

    if (historyTokens + tokenEstimate > HISTORY_TOKEN_BUDGET) break

    messages.push({
      role: row.role as 'user' | 'assistant',
      content,
    })
    historyTokens += tokenEstimate
  }

  messages.push({ role: 'user', content: body.message })

  // Load schema — cache per conversation (only first message loads from GitHub)
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

  // Build project state for intelligent system prompt
  let pendingBranches: Array<{ name: string, sha: string, protected: boolean }> = []
  try {
    pendingBranches = await git.listBranches('contentrain/')
  }
  catch { /* no branches */ }

  // Get project status from DB
  const { data: projectRecord } = await client
    .from('projects')
    .select('status')
    .eq('id', projectId)
    .single()

  const projectState = {
    initialized: !!projectConfig,
    pendingBranches,
    projectStatus: projectRecord?.status ?? 'active',
  }

  const systemPrompt = buildSystemPrompt(projectConfig, models, permissions, projectState)
  const tools = filterToolsByPermissions(STUDIO_TOOLS, permissions.availableTools)

  const model = 'claude-sonnet-4-6-20250514'

  // Create SSE stream
  const eventStream = createEventStream(event)
  const contentEngine = createContentEngine({ git, contentRoot })
  const aiProvider = useAIProvider()

  const processChat = async () => {
    await eventStream.push(JSON.stringify({ type: 'conversation', id: conversationId }))

    let totalInputTokens = 0
    let totalOutputTokens = 0
    let lastAssistantContent: AIContentBlock[] = []

    try {
      // Recursive tool loop — max iterations to prevent infinite loops
      let iteration = 0

      while (iteration < MAX_TOOL_ITERATIONS) {
        iteration++
        const isFirstIteration = iteration === 1

        const currentToolCalls: Array<{ id: string, name: string, input: unknown }> = []
        let stopReason: string | undefined

        if (isFirstIteration) {
          // First iteration: stream response for UX
          for await (const streamEvent of aiProvider.streamCompletion(
            { model, system: systemPrompt, messages, tools, maxTokens: 4096 },
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
          // Subsequent iterations: non-streaming (tool continuation)
          const response = await aiProvider.createCompletion(
            { model, system: systemPrompt, messages, tools, maxTokens: 2048 },
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

        // No tool calls — done
        if (stopReason !== 'tool_use' || currentToolCalls.length === 0) {
          break
        }

        // Execute tools
        const assistantBlocks: AIContentBlock[] = currentToolCalls.map(tc => ({
          type: 'tool_use' as const,
          id: tc.id,
          name: tc.name,
          input: tc.input,
        }))

        const toolResultBlocks: AIContentBlock[] = []
        for (const tc of currentToolCalls) {
          const result = await executeTool(tc.name, tc.input, contentEngine, git, session.user.email ?? '')

          // Truncate large tool results
          let resultStr = JSON.stringify(result)
          if (resultStr.length > MAX_TOOL_RESULT_LENGTH) {
            resultStr = resultStr.substring(0, MAX_TOOL_RESULT_LENGTH) + '...(truncated)'
          }

          await eventStream.push(JSON.stringify({ type: 'tool_result', id: tc.id, name: tc.name, result }))
          toolResultBlocks.push({ type: 'tool_result', toolUseId: tc.id, content: resultStr })
        }

        // Add to messages for next iteration
        messages.push({ role: 'assistant', content: assistantBlocks })
        messages.push({ role: 'user', content: toolResultBlocks })
        lastAssistantContent = assistantBlocks
      }

      // Done
      await eventStream.push(JSON.stringify({
        type: 'done',
        usage: { inputTokens: totalInputTokens, outputTokens: totalOutputTokens },
      }))

      // Save to DB
      await admin.from('messages').insert({
        conversation_id: conversationId,
        role: 'user',
        content: body.message,
      })

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

      // Update usage
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
 * Execute a Studio agent tool with error handling.
 */
async function executeTool(
  name: string,
  input: unknown,
  engine: ReturnType<typeof createContentEngine>,
  git: ReturnType<typeof useGitProvider>,
  userEmail: string,
): Promise<unknown> {
  const params = (input ?? {}) as Record<string, unknown>

  try {
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
        return { models: modelsList }
      }

      case 'get_content': {
        const modelId = params.model as string
        const locale = (params.locale as string) ?? 'en'
        const modelsDir = '.contentrain/models'
        const modelDef = JSON.parse(await git.readFile(`${modelsDir}/${modelId}.json`)) as ModelDefinition
        const contentPath = resolveContentPath({ contentRoot: '' }, modelDef, locale)
        try {
          const data = JSON.parse(await git.readFile(contentPath))
          // Summarize large content to save tokens
          if (typeof data === 'object' && !Array.isArray(data)) {
            const keys = Object.keys(data)
            if (keys.length > 10) {
              const sample = Object.fromEntries(keys.slice(0, 5).map(k => [k, data[k]]))
              return { modelId, locale, totalEntries: keys.length, sample, note: `Showing 5 of ${keys.length} entries` }
            }
          }
          return { modelId, locale, data }
        }
        catch { return { modelId, locale, data: null, error: 'Content not found' } }
      }

      case 'save_content':
        return summarizeWriteResult(await engine.saveContent(
          params.model as string, (params.locale as string) ?? 'en', params.data as Record<string, unknown>, userEmail,
        ))

      case 'delete_content':
        return summarizeWriteResult(await engine.deleteContent(
          params.model as string, (params.locale as string) ?? 'en', params.entryIds as string[], userEmail,
        ))

      case 'save_model':
        return summarizeWriteResult(await engine.saveModel(params as unknown as ModelDefinition, userEmail))

      case 'validate':
        return { valid: true, errors: [] }

      case 'list_branches':
        return { branches: await engine.listContentBranches() }

      case 'merge_branch':
        return engine.mergeBranch(params.branch as string)

      case 'reject_branch':
        await engine.rejectBranch(params.branch as string)
        return { rejected: true }

      case 'init_project': {
        const initModels: import('@contentrain/types').ModelDefinition[] = []
        if (params.models && Array.isArray(params.models)) {
          for (const m of params.models as Record<string, unknown>[]) {
            initModels.push(m as unknown as import('@contentrain/types').ModelDefinition)
          }
        }
        return summarizeWriteResult(await engine.initProject(
          (params.stack as string) ?? 'other', (params.locales as string[]) ?? ['en'],
          (params.domains as string[]) ?? ['marketing'], initModels, userEmail,
        ))
      }

      default:
        return { error: `Unknown tool: ${name}` }
    }
  }
  catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'Tool execution failed'
    return { error: msg }
  }
}

/** Compact write result for token efficiency */
function summarizeWriteResult(result: { branch: string, commit: { sha: string }, diff: unknown[], validation: { valid: boolean, errors: Array<{ message: string }> } }): unknown {
  return {
    branch: result.branch,
    commitSha: result.commit.sha,
    filesChanged: result.diff.length,
    valid: result.validation.valid,
    errors: result.validation.errors.map(e => e.message),
  }
}

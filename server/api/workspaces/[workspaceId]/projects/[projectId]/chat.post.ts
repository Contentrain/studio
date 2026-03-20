import type { ModelDefinition, ContentrainConfig } from '@contentrain/types'
import type { AIMessage, AIContentBlock } from '~~/server/providers/ai'
import { createEventStream } from 'h3'

/**
 * Chat SSE endpoint.
 *
 * POST → SSE stream (Server-Sent Events)
 * Handles: system prompt, streaming, tool execution loop, conversation persistence.
 *
 * Events emitted:
 *   { type: 'conversation', id }
 *   { type: 'text', content }
 *   { type: 'tool_use', id, name, input }
 *   { type: 'tool_result', id, name, result }
 *   { type: 'done', usage }
 *   { type: 'error', message }
 */
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

  // Resolve API key: BYOA first, then Studio key
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
    usageSource = 'studio'
  }
  else {
    throw createError({ statusCode: 400, message: 'No API key configured. Add one in workspace settings.' })
  }

  // Get or create conversation
  let conversationId = body.conversationId
  if (!conversationId) {
    const { data: conv } = await client
      .from('conversations')
      .insert({
        project_id: projectId,
        user_id: session.user.id,
        title: body.message.substring(0, 100),
      })
      .select('id')
      .single()
    conversationId = conv?.id
  }

  if (!conversationId)
    throw createError({ statusCode: 500, message: 'Failed to create conversation' })

  // Load conversation history (last 20 messages)
  const { data: historyRows } = await client
    .from('messages')
    .select('role, content, tool_calls')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: true })
    .limit(20)

  // Build AI messages from history
  const messages: AIMessage[] = (historyRows ?? []).map(row => ({
    role: row.role as 'user' | 'assistant',
    content: row.tool_calls
      ? (row.tool_calls as AIContentBlock[])
      : row.content,
  }))

  // Add current user message
  messages.push({ role: 'user', content: body.message })

  // Load project schema for system prompt
  const [owner, repo] = project.repo_full_name.split('/')
  const git = useGitProvider({
    installationId: workspace.github_installation_id,
    owner,
    repo,
  })

  const contentRoot = normalizeContentRoot(project.content_root)
  const modelsDir = contentRoot ? `${contentRoot}/.contentrain/models` : '.contentrain/models'
  const configPath = contentRoot ? `${contentRoot}/.contentrain/config.json` : '.contentrain/config.json'

  let projectConfig: ContentrainConfig | null = null
  const models: ModelDefinition[] = []

  try {
    projectConfig = JSON.parse(await git.readFile(configPath)) as ContentrainConfig
  }
  catch { /* no config */ }

  try {
    const modelFiles = await git.listDirectory(modelsDir)
    for (const file of modelFiles) {
      if (!file.endsWith('.json')) continue
      try {
        models.push(JSON.parse(await git.readFile(`${modelsDir}/${file}`)) as ModelDefinition)
      }
      catch { /* skip invalid */ }
    }
  }
  catch { /* no models dir */ }

  // Build system prompt
  const systemPrompt = buildSystemPrompt(projectConfig, models, permissions)

  // Filter tools by permissions
  const tools = filterToolsByPermissions(STUDIO_TOOLS, permissions.availableTools)

  // Select model based on plan
  const model = usageSource === 'studio'
    ? (workspace.plan === 'free' ? 'claude-haiku-4-5-20251001' : 'claude-sonnet-4-5-20250514')
    : 'claude-sonnet-4-5-20250514' // BYOA users get best model

  // Create SSE stream
  const eventStream = createEventStream(event)

  // Send conversation ID
  await eventStream.push(JSON.stringify({ type: 'conversation', id: conversationId }))

  // Content Engine for tool execution
  const contentEngine = createContentEngine({ git, contentRoot })

  // AI provider
  const aiProvider = useAIProvider()

  // Process in background (don't await — SSE streams)
  const processChat = async () => {
    let totalInputTokens = 0
    let totalOutputTokens = 0
    let assistantContent: AIContentBlock[] = []

    try {
      // Stream first response
      let currentToolCalls: Array<{ id: string, name: string, input: unknown }> = []

      for await (const streamEvent of aiProvider.streamCompletion(
        { model, system: systemPrompt, messages, tools, maxTokens: 4096 },
        apiKey,
      )) {
        switch (streamEvent.type) {
          case 'text':
            await eventStream.push(JSON.stringify({ type: 'text', content: streamEvent.content }))
            break

          case 'tool_use_start':
            await eventStream.push(JSON.stringify({
              type: 'tool_use',
              id: streamEvent.toolId,
              name: streamEvent.toolName,
            }))
            break

          case 'tool_use_end':
            currentToolCalls.push({
              id: streamEvent.toolId!,
              name: streamEvent.toolName!,
              input: streamEvent.toolInput,
            })
            break

          case 'message_end':
            totalInputTokens += streamEvent.usage?.inputTokens ?? 0
            totalOutputTokens += streamEvent.usage?.outputTokens ?? 0

            // If tool use — execute tools and continue
            if (streamEvent.stopReason === 'tool_use' && currentToolCalls.length > 0) {
              // Build assistant content blocks
              assistantContent = []
              for (const tc of currentToolCalls) {
                assistantContent.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.input })
              }

              // Execute each tool
              for (const tc of currentToolCalls) {
                const result = await executeTool(tc.name, tc.input, contentEngine, git, session.user.email ?? '')
                await eventStream.push(JSON.stringify({
                  type: 'tool_result',
                  id: tc.id,
                  name: tc.name,
                  result,
                }))

                // Add tool result to messages for continuation
                messages.push({
                  role: 'assistant',
                  content: assistantContent,
                })
                messages.push({
                  role: 'user',
                  content: [{ type: 'tool_result', toolUseId: tc.id, content: JSON.stringify(result) }],
                })
              }

              // Continue conversation with tool results (non-streaming for simplicity)
              const continuation = await aiProvider.createCompletion(
                { model, system: systemPrompt, messages, tools, maxTokens: 4096 },
                apiKey,
              )

              totalInputTokens += continuation.usage.inputTokens
              totalOutputTokens += continuation.usage.outputTokens

              // Send continuation text
              for (const block of continuation.content) {
                if (block.type === 'text') {
                  await eventStream.push(JSON.stringify({ type: 'text', content: block.text }))
                }
              }

              assistantContent = continuation.content
              currentToolCalls = []
            }
            break

          case 'error':
            await eventStream.push(JSON.stringify({ type: 'error', message: streamEvent.error }))
            break
        }
      }

      // Done
      await eventStream.push(JSON.stringify({
        type: 'done',
        usage: { inputTokens: totalInputTokens, outputTokens: totalOutputTokens },
      }))

      // Save messages to DB (using admin to bypass RLS for system inserts)
      await admin.from('messages').insert({
        conversation_id: conversationId,
        role: 'user',
        content: body.message,
      })

      // Collect assistant text
      const assistantText = assistantContent
        .filter(b => b.type === 'text')
        .map(b => (b as { text: string }).text)
        .join('')

      await admin.from('messages').insert({
        conversation_id: conversationId,
        role: 'assistant',
        content: assistantText || '[tool calls]',
        tool_calls: assistantContent.length > 0 ? assistantContent : null,
        token_count_input: totalInputTokens,
        token_count_output: totalOutputTokens,
        model,
      })

      // Update usage
      const month = new Date().toISOString().substring(0, 7) // '2026-03'
      await admin.from('agent_usage').upsert({
        workspace_id: workspaceId,
        user_id: session.user.id,
        month,
        source: usageSource,
        message_count: 1,
        input_tokens: totalInputTokens,
        output_tokens: totalOutputTokens,
      }, {
        onConflict: 'workspace_id,user_id,month,source',
      })

      // Update conversation timestamp
      await admin.from('conversations').update({ updated_at: new Date().toISOString() }).eq('id', conversationId)
    }
    catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Chat error'
      await eventStream.push(JSON.stringify({ type: 'error', message: msg }))
    }
    finally {
      await eventStream.close()
    }
  }

  processChat()

  eventStream.onClosed(() => {
    // Client disconnected — cleanup if needed
  })

  return eventStream.send()
})

/**
 * Execute a Studio agent tool.
 * Routes tool calls to the Content Engine.
 */
async function executeTool(
  name: string,
  input: unknown,
  engine: ReturnType<typeof createContentEngine>,
  git: ReturnType<typeof useGitProvider>,
  userEmail: string,
): Promise<unknown> {
  const params = (input ?? {}) as Record<string, unknown>

  switch (name) {
    case 'list_models': {
      const modelsDir = '.contentrain/models'
      const files = await git.listDirectory(modelsDir)
      const models = []
      for (const file of files) {
        if (!file.endsWith('.json')) continue
        try {
          models.push(JSON.parse(await git.readFile(`${modelsDir}/${file}`)))
        }
        catch { /* skip */ }
      }
      return { models }
    }

    case 'get_content': {
      const modelId = params.model as string
      const locale = (params.locale as string) ?? 'en'
      const modelsDir = '.contentrain/models'
      const modelDef = JSON.parse(await git.readFile(`${modelsDir}/${modelId}.json`)) as ModelDefinition
      const contentPath = resolveContentPath(
        { contentRoot: '' },
        modelDef,
        locale,
      )
      try {
        const content = JSON.parse(await git.readFile(contentPath))
        return { modelId, locale, data: content }
      }
      catch {
        return { modelId, locale, data: null, error: 'Content not found' }
      }
    }

    case 'save_content': {
      const result = await engine.saveContent(
        params.model as string,
        (params.locale as string) ?? 'en',
        params.data as Record<string, unknown>,
        userEmail,
      )
      return {
        branch: result.branch,
        commitSha: result.commit.sha,
        validation: result.validation,
        filesChanged: result.diff.length,
      }
    }

    case 'delete_content':
      return engine.deleteContent(
        params.model as string,
        (params.locale as string) ?? 'en',
        params.entryIds as string[],
        userEmail,
      )

    case 'save_model':
      return engine.saveModel(params as unknown as ModelDefinition, userEmail)

    case 'validate':
      // TODO: implement full validation across models
      return { valid: true, errors: [] }

    case 'list_branches':
      return { branches: await engine.listContentBranches() }

    case 'merge_branch':
      return engine.mergeBranch(params.branch as string)

    case 'reject_branch': {
      await engine.rejectBranch(params.branch as string)
      return { rejected: true }
    }

    case 'init_project': {
      const initModels: import('@contentrain/types').ModelDefinition[] = []
      if (params.models && Array.isArray(params.models)) {
        for (const m of params.models as Record<string, unknown>[]) {
          initModels.push(m as unknown as import('@contentrain/types').ModelDefinition)
        }
      }
      const initResult = await engine.initProject(
        (params.stack as string) ?? 'other',
        (params.locales as string[]) ?? ['en'],
        (params.domains as string[]) ?? ['marketing'],
        initModels,
        userEmail,
      )
      return {
        branch: initResult.branch,
        commitSha: initResult.commit.sha,
        filesCreated: initResult.diff.length,
      }
    }

    default:
      return { error: `Unknown tool: ${name}` }
  }
}

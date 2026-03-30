/**
 * Conversation API — public message endpoint.
 *
 * Auth: Bearer API key (crn_conv_*), not session-based.
 * Plan: requires api.conversation feature (Business+).
 *
 * Flow:
 * 1. Validate API key
 * 2. Verify projectId matches key's project
 * 3. Lookup workspace → plan check
 * 4. Rate limit per key
 * 5. Monthly limit check
 * 6. Build permissions from key config
 * 7. Build brain cache, system prompt, tools
 * 8. Call runConversationLoop() and collect events
 * 9. Return JSON response
 */
import type { AIMessage, AIContentBlock } from '~~/server/providers/ai'
import type { ChatUIContext } from '~~/server/utils/agent-types'
import type { AgentPermissions } from '~~/server/utils/agent-permissions'
import { toAITools } from '~~/server/utils/agent-types'
import { deriveProjectPhase } from '~~/server/utils/agent-state-machine'
import { classifyIntent } from '~~/server/utils/agent-context'
import { runConversationLoop } from '~~/server/utils/conversation-engine'

interface ConversationMessageRequest {
  message: string
  conversationId?: string
  context?: Partial<ChatUIContext>
}

// Tool → minimum role (same mapping as agent-permissions, scoped to API key roles)
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

export default defineEventHandler(async (event) => {
  // === VALIDATE API KEY ===
  const authHeader = getHeader(event, 'authorization')
  const keyData = await validateConversationKey(authHeader)

  // === VERIFY PROJECT MATCH ===
  const routeProjectId = getRouterParam(event, 'projectId')
  if (!routeProjectId || routeProjectId !== keyData.projectId)
    throw createError({ statusCode: 403, message: errorMessage('conversation.key_invalid') })

  // === READ BODY ===
  const body = await readBody<ConversationMessageRequest>(event)
  if (!body.message?.trim())
    throw createError({ statusCode: 400, message: errorMessage('validation.message_required') })

  // Message length limit — prevent token cost attacks
  if (body.message.length > 10_000)
    throw createError({ statusCode: 400, message: errorMessage('validation.message_required') })

  const admin = useSupabaseAdmin()

  // === WORKSPACE + PLAN CHECK ===
  const { data: project } = await admin
    .from('projects')
    .select('id, repo_full_name, content_root, workspace_id, default_branch, detected_stack, status')
    .eq('id', keyData.projectId)
    .eq('workspace_id', keyData.workspaceId)
    .single()

  if (!project)
    throw createError({ statusCode: 404, message: errorMessage('project.not_found') })

  const { data: workspace } = await admin
    .from('workspaces')
    .select('id, github_installation_id, plan, slug, name, owner_id')
    .eq('id', keyData.workspaceId)
    .single()

  if (!workspace?.github_installation_id)
    throw createError({ statusCode: 400, message: errorMessage('github.installation_missing') })

  const plan = getWorkspacePlan(workspace)
  if (!hasFeature(plan, 'api.conversation'))
    throw createError({ statusCode: 403, message: errorMessage('conversation.upgrade') })

  // === RATE LIMIT PER KEY ===
  const rateCheck = checkRateLimit(`conv:${keyData.keyId}`, keyData.rateLimitPerMinute, 60_000)
  if (!rateCheck.allowed)
    throw createError({ statusCode: 429, message: errorMessage('chat.rate_limited', { seconds: Math.ceil(rateCheck.retryAfterMs / 1000) }) })

  // === MONTHLY LIMIT ===
  const month = new Date().toISOString().substring(0, 7)
  const { data: usageRows } = await admin
    .from('agent_usage')
    .select('message_count')
    .eq('workspace_id', keyData.workspaceId)
    .eq('month', month)
    .eq('api_key_id', keyData.keyId)

  const totalCount = (usageRows ?? []).reduce((sum, r) => sum + (r.message_count ?? 0), 0)
  if (totalCount >= keyData.monthlyMessageLimit)
    throw createError({ statusCode: 429, message: errorMessage('conversation.monthly_limit', { limit: keyData.monthlyMessageLimit }) })

  // === BUILD PERMISSIONS FROM KEY CONFIG ===
  const keyRole = keyData.role
  let availableTools = Object.entries(API_TOOL_ROLES)
    .filter(([_, roles]) => roles.includes(keyRole))
    .map(([name]) => name)

  // If key has allowedTools restriction, intersect
  if (keyData.allowedTools.length > 0) {
    availableTools = availableTools.filter(t => keyData.allowedTools.includes(t))
  }

  const permissions: AgentPermissions = {
    workspaceRole: keyRole === 'admin' ? 'admin' : 'member',
    projectRole: keyRole === 'admin' ? null : keyRole as AgentPermissions['projectRole'],
    specificModels: keyData.specificModels,
    allowedModels: keyData.allowedModels,
    availableTools,
  }

  // === GIT PROVIDER ===
  const [owner, repo] = project.repo_full_name.split('/')
  const git = useGitProvider({
    installationId: workspace.github_installation_id,
    owner,
    repo,
  })

  const contentRoot = normalizeContentRoot(project.content_root)

  // === BRAIN CACHE ===
  const brain = await getOrBuildBrainCache(git, contentRoot, keyData.projectId)
  const projectConfig = brain.config
  const models = [...brain.models.values()]
  const vocabulary = brain.vocabulary
  const contentContext = brain.contentContext

  // === UI CONTEXT (API callers can pass partial context) ===
  const uiContext: ChatUIContext = {
    activeModelId: body.context?.activeModelId ?? null,
    activeLocale: body.context?.activeLocale ?? 'en',
    activeEntryId: body.context?.activeEntryId ?? null,
    panelState: body.context?.panelState ?? 'overview',
    activeBranch: body.context?.activeBranch ?? null,
  }

  // === STATE MACHINE ===
  let pendingBranches: Array<{ name: string, sha: string, protected: boolean }> = []
  try {
    pendingBranches = await git.listBranches('cr/')
  }
  catch { /* no branches */ }

  const phase = deriveProjectPhase(projectConfig, pendingBranches, project.status ?? 'active')

  // === INTENT CLASSIFICATION ===
  const intent = classifyIntent(body.message, uiContext, phase)

  // === SYSTEM PROMPT ===
  let systemPrompt = buildSystemPrompt(
    projectConfig, models, permissions,
    { initialized: !!projectConfig, pendingBranches, projectStatus: project.status ?? 'active', phase, contentContext },
    uiContext, intent, vocabulary, plan, keyData.customInstructions,
  )

  const contentIndex = buildContentIndex(brain)
  if (contentIndex) {
    systemPrompt += `\n\n${contentIndex}`
  }

  // === FILTER TOOLS ===
  const permissionFiltered = filterToolsByPermissions(STUDIO_TOOLS, permissions.availableTools) as typeof STUDIO_TOOLS
  const phaseFiltered = permissionFiltered.filter(t => t.requiredPhase.includes(phase))
  const aiTools = toAITools(phaseFiltered)

  // === API KEY (always uses studio key for Conversation API) ===
  const runtimeConfig = useRuntimeConfig()
  const apiKey = runtimeConfig.anthropic.apiKey
  if (!apiKey)
    throw createError({ statusCode: 500, message: errorMessage('chat.no_api_key') })

  // === CONVERSATION ===
  let conversationId = body.conversationId

  if (conversationId) {
    // Verify conversation belongs to this project + this specific API key
    const { data: conv } = await admin
      .from('conversations')
      .select('id')
      .eq('id', conversationId)
      .eq('project_id', keyData.projectId)
      .eq('user_id', keyData.keyId)
      .single()

    if (!conv) conversationId = undefined
  }

  if (!conversationId) {
    const { data: newConv } = await admin
      .from('conversations')
      .insert({
        project_id: keyData.projectId,
        user_id: keyData.keyId, // API key ID as user_id for API conversations
        title: body.message.substring(0, 100),
      })
      .select('id')
      .single()

    conversationId = newConv?.id
  }

  if (!conversationId)
    throw createError({ statusCode: 500, message: errorMessage('chat.conversation_create_failed') })

  // === HISTORY ===
  const { data: historyRows } = await admin
    .from('messages')
    .select('role, content, tool_calls')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: true })
    .limit(50)

  const allHistory = historyRows ?? []
  const messages: AIMessage[] = []
  const HISTORY_TOKEN_BUDGET = 8000

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

  // === MODEL SELECTION ===
  const model = keyData.aiModel

  // === WORKFLOW ===
  const configWorkflow = projectConfig?.workflow ?? 'auto-merge'
  const workflow = hasFeature(plan, 'workflow.review') ? configWorkflow : 'auto-merge'

  // === RUN CONVERSATION LOOP (collect events, not SSE) ===
  const contentEngine = createContentEngine({ git, contentRoot })
  const toolResults: Array<{ id: string, name: string, result: unknown }> = []
  let responseText = ''
  let totalInputTokens = 0
  let totalOutputTokens = 0
  let lastAssistantContent: AIContentBlock[] = []

  for await (const evt of runConversationLoop(
    { model, apiKey, systemPrompt, messages, tools: aiTools },
    {
      engine: contentEngine, git,
      userEmail: `api-key:${keyData.name}`,
      userId: keyData.keyId,
      contentRoot, workflow, permissions, plan,
      projectId: keyData.projectId,
      workspaceId: keyData.workspaceId,
      uiContext, phase,
    },
  )) {
    switch (evt.type) {
      case 'text':
        responseText += evt.content as string
        break
      case 'tool_result':
        toolResults.push({ id: evt.id as string, name: evt.name as string, result: evt.result })
        break
      case 'done':
        totalInputTokens = (evt.usage as { inputTokens: number })?.inputTokens ?? 0
        totalOutputTokens = (evt.usage as { outputTokens: number })?.outputTokens ?? 0
        lastAssistantContent = (evt.lastContent as AIContentBlock[]) ?? []
        break
    }
  }

  // === SAVE TO DB ===
  await saveChatResult(
    admin, conversationId, body.message, responseText,
    lastAssistantContent, model, totalInputTokens, totalOutputTokens,
    keyData.workspaceId, keyData.keyId, 'studio',
  )

  // === TRACK API KEY USAGE ===
  const { data: existingUsage } = await admin
    .from('agent_usage')
    .select('id, message_count, input_tokens, output_tokens')
    .eq('workspace_id', keyData.workspaceId)
    .eq('api_key_id', keyData.keyId)
    .eq('month', month)
    .eq('source', 'api')
    .single()

  if (existingUsage) {
    await admin.from('agent_usage').update({
      message_count: (existingUsage.message_count ?? 0) + 1,
      input_tokens: (existingUsage.input_tokens ?? 0) + totalInputTokens,
      output_tokens: (existingUsage.output_tokens ?? 0) + totalOutputTokens,
      updated_at: new Date().toISOString(),
    }).eq('id', existingUsage.id)
  }
  else {
    await admin.from('agent_usage').insert({
      workspace_id: keyData.workspaceId,
      user_id: keyData.keyId,
      api_key_id: keyData.keyId,
      month,
      source: 'api',
      message_count: 1,
      input_tokens: totalInputTokens,
      output_tokens: totalOutputTokens,
    })
  }

  return {
    conversationId,
    message: responseText,
    toolResults: toolResults.length > 0 ? toolResults : undefined,
    usage: {
      inputTokens: totalInputTokens,
      outputTokens: totalOutputTokens,
    },
  }
})

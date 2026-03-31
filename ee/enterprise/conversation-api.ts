import { createError, getHeader, getQuery, getRouterParam, readBody, type H3Event } from 'h3'
import { useRuntimeConfig } from '#imports'
import type { AIContentBlock, AIMessage } from '../../server/providers/ai'
import type { DatabaseClientBridge } from '../../server/providers/database'
import type { AgentPermissions } from '../../server/utils/agent-permissions'
import type { ChatUIContext } from '../../server/utils/agent-types'
import { toAITools } from '../../server/utils/agent-types'
import { classifyIntent } from '../../server/utils/agent-context'
import { deriveProjectPhase } from '../../server/utils/agent-state-machine'
import { buildSystemPrompt } from '../../server/utils/agent-system-prompt'
import { STUDIO_TOOLS, filterToolsByPermissions } from '../../server/utils/agent-tools'
import { buildContentIndex, getOrBuildBrainCache } from '../../server/utils/brain-cache'
import { createContentEngine } from '../../server/utils/content-engine'
import { errorMessage } from '../../server/utils/content-strings'
import { normalizeContentRoot } from '../../server/utils/content-paths'
import { runConversationLoop } from '../../server/utils/conversation-engine'
import { validateConversationKey } from '../../server/utils/conversation-keys'
import { saveChatResult } from '../../server/utils/db'
import { getWorkspacePlan, hasFeature } from '../../server/utils/license'
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
  admin: DatabaseClientBridge
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

  const admin = db.getAdminClient()
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

  return { admin, keyData, project, workspace, plan }
}

async function loadConversationMessages(
  admin: DatabaseClientBridge,
  conversationId: string,
  limit: number,
) {
  const { data: messageRows } = await admin
    .from('messages')
    .select('id, role, content, tool_calls, model, token_count_input, token_count_output, created_at')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: true })
    .limit(limit)

  return (messageRows ?? []).map((row: {
    id: string
    role: string
    content: string
    tool_calls: unknown[] | null
    model: string | null
    token_count_input: number | null
    token_count_output: number | null
    created_at: string
  }) => ({
    id: row.id,
    role: row.role,
    content: row.content,
    toolCalls: row.tool_calls ?? undefined,
    model: row.model ?? undefined,
    usage: (row.token_count_input || row.token_count_output)
      ? { inputTokens: row.token_count_input ?? 0, outputTokens: row.token_count_output ?? 0 }
      : undefined,
    createdAt: row.created_at,
  }))
}

async function runConversationMessage(
  event: H3Event,
  body: { message: string, conversationId?: string, context?: Partial<ChatUIContext> },
) {
  const { admin, keyData, project, workspace, plan } = await resolveConversationApiContext(event)

  if (!body.message?.trim())
    throw createError({ statusCode: 400, message: errorMessage('validation.message_required') })

  if (body.message.length > 10_000)
    throw createError({ statusCode: 400, message: errorMessage('validation.message_required') })

  const rateCheck = checkRateLimit(`conv:${keyData.keyId}`, keyData.rateLimitPerMinute, 60_000)
  if (!rateCheck.allowed)
    throw createError({ statusCode: 429, message: errorMessage('chat.rate_limited', { seconds: Math.ceil(rateCheck.retryAfterMs / 1000) }) })

  const month = new Date().toISOString().substring(0, 7)
  const { data: usageRows } = await admin
    .from('agent_usage')
    .select('message_count')
    .eq('workspace_id', keyData.workspaceId)
    .eq('month', month)
    .eq('api_key_id', keyData.keyId)

  const totalCount = (usageRows ?? []).reduce((sum, row) => sum + (row.message_count ?? 0), 0)
  if (totalCount >= keyData.monthlyMessageLimit)
    throw createError({ statusCode: 429, message: errorMessage('conversation.monthly_limit', { limit: keyData.monthlyMessageLimit }) })

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
    pendingBranches = await git.listBranches('cr/')
  }
  catch (err) {
    // eslint-disable-next-line no-console
    console.error('[conversation-api] Failed to list branches:', err)
  }

  const phase = deriveProjectPhase(projectConfig, pendingBranches, project.status ?? 'active')
  const intent = classifyIntent(body.message, uiContext, phase)

  let systemPrompt = buildSystemPrompt(
    projectConfig,
    models,
    permissions,
    { initialized: !!projectConfig, pendingBranches, projectStatus: project.status ?? 'active', phase, contentContext },
    uiContext,
    intent,
    vocabulary,
    plan,
    keyData.customInstructions,
  )

  const contentIndex = buildContentIndex(brain)
  if (contentIndex)
    systemPrompt += `\n\n${contentIndex}`

  const permissionFiltered = filterToolsByPermissions(STUDIO_TOOLS, permissions.availableTools) as typeof STUDIO_TOOLS
  const phaseFiltered = permissionFiltered.filter(tool => tool.requiredPhase.includes(phase))
  const aiTools = toAITools(phaseFiltered)

  const runtimeConfig = useRuntimeConfig()
  const apiKey = runtimeConfig.anthropic.apiKey
  if (!apiKey)
    throw createError({ statusCode: 500, message: errorMessage('chat.no_api_key') })

  let conversationId = body.conversationId
  if (conversationId) {
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
        user_id: keyData.keyId,
        title: body.message.substring(0, 100),
      })
      .select('id')
      .single()

    conversationId = newConv?.id
  }

  if (!conversationId)
    throw createError({ statusCode: 500, message: errorMessage('chat.conversation_create_failed') })

  const historyRows = await loadConversationMessages(admin, conversationId, 50)
  const messages: AIMessage[] = []
  const HISTORY_TOKEN_BUDGET = 8000

  const budgetStart = (() => {
    let tokens = 0
    for (let i = historyRows.length - 1; i >= 0; i--) {
      const row = historyRows[i]!
      const content = row.toolCalls ? (row.toolCalls as AIContentBlock[]) : row.content
      const estimate = typeof content === 'string'
        ? Math.ceil(content.length / 4)
        : Math.ceil(JSON.stringify(content).length / 4)
      tokens += estimate
      if (tokens > HISTORY_TOKEN_BUDGET) return i + 1
    }
    return 0
  })()

  for (let i = budgetStart; i < historyRows.length; i++) {
    const row = historyRows[i]!
    const content = row.toolCalls ? (row.toolCalls as AIContentBlock[]) : row.content
    messages.push({ role: row.role as 'user' | 'assistant', content })
  }
  messages.push({ role: 'user', content: body.message })

  const model = keyData.aiModel
  const configWorkflow = projectConfig?.workflow ?? 'auto-merge'
  const workflow = hasFeature(plan, 'workflow.review') ? configWorkflow : 'auto-merge'

  const contentEngine = createContentEngine({ git, contentRoot })
  const toolResults: Array<{ id: string, name: string, result: unknown }> = []
  let responseText = ''
  let totalInputTokens = 0
  let totalOutputTokens = 0
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

  await saveChatResult(
    conversationId,
    body.message,
    responseText,
    lastAssistantContent,
    model,
    totalInputTokens,
    totalOutputTokens,
    keyData.workspaceId,
    keyData.keyId,
    'api',
    keyData.keyId,
  )

  return {
    conversationId,
    message: responseText,
    toolResults: toolResults.length > 0 ? toolResults : undefined,
    usage: {
      inputTokens: totalInputTokens,
      outputTokens: totalOutputTokens,
    },
  }
}

async function runConversationHistory(event: H3Event) {
  const { admin, keyData } = await resolveConversationApiContext(event)

  const query = getQuery(event)
  const conversationId = query.conversationId as string | undefined
  if (!conversationId)
    throw createError({ statusCode: 400, message: errorMessage('validation.conversation_id_required') })

  const { data: conv } = await admin
    .from('conversations')
    .select('id')
    .eq('id', conversationId)
    .eq('project_id', keyData.projectId)
    .eq('user_id', keyData.keyId)
    .single()

  if (!conv)
    throw createError({ statusCode: 404, message: errorMessage('chat.conversation_not_found') })

  const limit = Math.min(Number(query.limit ?? 50), 100)
  const messages = await loadConversationMessages(admin, conversationId, limit)

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

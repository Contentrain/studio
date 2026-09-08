import type { GitProvider } from '../providers/git'
import { normalizeContentRoot } from './content-paths'

// ─── Cross-domain: Chat Persistence ───

import { randomUUID } from 'node:crypto'
import type { MessageInsertInput } from '../providers/database'
import type { AIContentBlock } from '../providers/ai'
import type { IterationTrace } from './conversation-engine'

/**
 * Cross-provider database utilities.
 *
 * Contains functions that span multiple providers (DB + Git, DB + Auth + Email).
 * Pure DB operations live in DatabaseProvider (server/providers/supabase-db/).
 */

// ─── Types (re-exported for backward compat) ───

export interface ProjectRow {
  id: string
  repo_full_name: string
  content_root: string
  workspace_id: string
  default_branch?: string
  detected_stack?: string
  status?: string
  /** Validated `MigrationHandoff` document when the repo came from Contentrain Migrate. */
  migration_handoff?: Record<string, unknown> | null
}

export interface WorkspaceRow {
  id: string
  github_installation_id: number | null
  plan?: string
  slug?: string
  name?: string
  owner_id?: string
}

export interface ProjectContext {
  project: ProjectRow
  workspace: WorkspaceRow
  git: GitProvider
  contentRoot: string
}

export interface MemberRow {
  id: string
  role: string
  invited_email?: string | null
  invited_at?: string | null
  accepted_at?: string | null
  specific_models?: boolean
  allowed_models?: string[]
  profiles?: {
    id: string
    display_name?: string | null
    email?: string
    avatar_url?: string | null
  } | null
}

export interface MediaAssetRow {
  id: string
  project_id: string
  workspace_id: string
  filename: string
  content_type: string
  size_bytes: number
  content_hash: string
  width: number | null
  height: number | null
  format: string
  blurhash: string | null
  focal_point: { x: number, y: number } | null
  duration_seconds: number | null
  alt: string | null
  tags: string[]
  original_path: string
  variants: Record<string, { path: string, width: number, height: number, format: string, size: number }>
  uploaded_by: string
  source: string
  created_at: string
  updated_at: string
}

export interface FormSubmissionInsert {
  project_id: string
  workspace_id: string
  model_id: string
  data: Record<string, unknown>
  source_ip?: string
  user_agent?: string
  referrer?: string
  locale?: string
}

export interface FormSubmissionRow {
  id: string
  project_id: string
  workspace_id: string
  model_id: string
  data: Record<string, unknown>
  status: 'pending' | 'approved' | 'rejected' | 'spam'
  source_ip: string | null
  user_agent: string | null
  referrer: string | null
  locale: string
  approved_at: string | null
  approved_by: string | null
  entry_id: string | null
  created_at: string
}

/**
 * Verify the authenticated user has access to a project.
 * Checks workspace membership first, then project-level access for members.
 * Owner/admin have implicit access to all projects.
 */
export async function requireProjectAccess(
  userId: string,
  workspaceId: string,
  projectId: string,
  accessToken: string,
): Promise<void> {
  const db = useDatabaseProvider()
  const role = await db.requireWorkspaceRole(accessToken, userId, workspaceId, ['owner', 'admin', 'member'])
  if (role === 'member') {
    const pm = await db.getProjectMember(projectId, userId)
    if (!pm)
      throw createError({ statusCode: 403, message: errorMessage('project.access_denied') })
  }
}

// ─── Cross-provider: DB + Git ───

/**
 * Resolve project, workspace, and GitProvider in one call.
 * Used by ~10 routes that need to read/write content via Git.
 */
export async function resolveProjectContext(
  workspaceId: string,
  projectId: string,
): Promise<ProjectContext> {
  const db = useDatabaseProvider()

  const project = await db.getProjectById(projectId, 'id, repo_full_name, content_root, workspace_id, default_branch, detected_stack, status, migration_handoff')
  if (!project || project.workspace_id !== workspaceId)
    throw createError({ statusCode: 404, message: errorMessage('project.not_found') })

  const workspace = await db.getWorkspaceById(workspaceId, 'id, github_installation_id, plan, slug, name, owner_id')
  if (!workspace?.github_installation_id)
    throw createError({ statusCode: 400, message: errorMessage('github.installation_missing') })

  const [owner = '', repo = ''] = String(project.repo_full_name).split('/')
  const git = useGitProvider({
    installationId: workspace.github_installation_id as number,
    owner,
    repo,
  })

  return {
    project: project as unknown as ProjectRow,
    workspace: workspace as unknown as WorkspaceRow,
    git,
    contentRoot: normalizeContentRoot(project.content_root as string),
  }
}

// ─── Cross-provider: DB + Auth + Email ───

/**
 * Invite a user by email — creates account if needed, returns userId.
 * Falls back to user lookup if invite fails (already exists).
 */
export async function inviteOrLookupUser(
  email: string,
  context?: { workspaceName: string, inviterName: string, workspaceSlug: string },
): Promise<{ userId: string, isNewUser: boolean }> {
  const authProvider = useAuthProvider()

  try {
    const config = useRuntimeConfig()
    const redirectTo = context?.workspaceSlug
      ? `${config.public.siteUrl}/auth/callback?workspace=${context.workspaceSlug}`
      : undefined
    const result = await authProvider.inviteUserByEmail(email, { redirectTo })
    return { userId: result.userId, isNewUser: true }
  }
  catch (inviteErr: unknown) {
    // Only fall through to user lookup if the error indicates "user already exists".
    // Transient provider errors (network, rate limit, etc.) should propagate.
    const errMsg = (inviteErr as { message?: string })?.message ?? ''
    const statusCode = (inviteErr as { statusCode?: number })?.statusCode
    const isAlreadyExists = errMsg.toLowerCase().includes('already') || statusCode === 422
    if (!isAlreadyExists) {
      throw createError({ statusCode: statusCode ?? 500, message: errorMessage('auth.invite_failed', { detail: errMsg }) })
    }

    // User already exists — look up by email via AuthProvider
    const existing = await authProvider.getUserByEmail(email)
    if (!existing?.id)
      throw createError({ statusCode: 400, message: errorMessage('members.could_not_invite') })

    // Send notification email to existing user
    if (context) {
      const emailProvider = useEmailProvider()
      if (emailProvider) {
        const config = useRuntimeConfig()
        const workspaceUrl = `${config.public.siteUrl}/w/${context.workspaceSlug}`
        const tpl = emailTemplate('invite-added', {
          workspaceName: context.workspaceName,
          inviterName: context.inviterName,
          workspaceUrl,
        })
        emailProvider.sendEmail({
          to: email,
          subject: tpl.subject,
          html: tpl.body,
        }).catch(() => { /* best-effort notification */ })
      }
    }

    return { userId: existing.id, isNewUser: false }
  }
}

/**
 * Compose the row trace for a single chat POST and write it as one
 * batched INSERT.
 *
 * Shape per POST:
 *   - 1 seed user row (the prompt). `internal=false`, `iteration=NULL`.
 *   - For each engine iteration:
 *       - 1 assistant row carrying `content_blocks` (text + tool_use).
 *       - 0 or 1 tool_result row (role='user', content_blocks=[tool_result...])
 *         when the iteration triggered tool execution.
 *   - All rows share a single freshly-minted `turn_id`. `turn_sequence`
 *     starts at 0 (seed user) and increments by 1 per row so two rows
 *     landing at the same `created_at` tick still resolve in order.
 *
 * Visibility (`internal=true`):
 *   - Every assistant iteration row is visible — the transcript shows
 *     the full chronological narration + tool trace of the turn (the
 *     client groups same-turn assistant rows into one message and
 *     renders their `content_blocks` as ordered segments).
 *   - tool_result rows stay internal: they are protocol-replay
 *     payload (often large truncated JSON) and never render.
 *
 * Token columns land only on the final assistant row —
 * Anthropic's `usage` is per-call total, not per-iteration.
 */
function buildTraceRows(input: {
  conversationId: string
  userMessage: string
  /**
   * Structured content blocks for the seed user row. When attachments
   * are present this carries the attachment blocks (image/document/text)
   * plus the user text so the protocol shape replays across turns and
   * the UI can re-render attachments from history. `content` stays as
   * the plain-text fallback for the legacy column / transcript.
   */
  userContentBlocks?: AIContentBlock[]
  trace: IterationTrace[]
  lastAssistantContent: AIContentBlock[]
  model: string
  inputTokens: number
  outputTokens: number
  cacheCreationInputTokens: number
  cacheReadInputTokens: number
}): MessageInsertInput[] {
  const turnId = randomUUID()
  const rows: MessageInsertInput[] = []
  let seq = 0

  rows.push({
    conversationId: input.conversationId,
    role: 'user',
    content: input.userMessage,
    ...(input.userContentBlocks && input.userContentBlocks.length > 0
      ? { contentBlocks: input.userContentBlocks }
      : {}),
    turnId,
    turnSequence: seq++,
    iteration: null,
    internal: false,
  })

  const trace = input.trace.length > 0
    ? input.trace
    // Defensive fallback: the engine should always emit at least one
    // iteration before yielding `done`, but if the loop bailed before
    // pushing a trace entry (e.g. abort between provider start and
    // first event) we still write the last known assistant content
    // so the transcript isn't blank.
    : [{ iteration: 1, assistantBlocks: input.lastAssistantContent, toolResultBlocks: [] }]

  const lastIndex = trace.length - 1
  for (let i = 0; i < trace.length; i++) {
    const iter = trace[i]!
    const isFinal = i === lastIndex
    const assistantText = iter.assistantBlocks
      .filter(b => b.type === 'text')
      .map(b => (b as { text: string }).text)
      .join('')

    rows.push({
      conversationId: input.conversationId,
      role: 'assistant',
      content: assistantText || '[tool calls]',
      contentBlocks: iter.assistantBlocks,
      turnId,
      turnSequence: seq++,
      iteration: iter.iteration,
      internal: false,
      ...(isFinal
        ? {
            tokenCountInput: input.inputTokens,
            tokenCountOutput: input.outputTokens,
            cacheCreationInputTokens: input.cacheCreationInputTokens,
            cacheReadInputTokens: input.cacheReadInputTokens,
            model: input.model,
          }
        : {}),
    })

    if (iter.toolResultBlocks.length > 0) {
      rows.push({
        conversationId: input.conversationId,
        role: 'user',
        content: '[tool results]',
        contentBlocks: iter.toolResultBlocks,
        turnId,
        turnSequence: seq++,
        iteration: iter.iteration,
        internal: true,
      })
    }
  }

  return rows
}

/**
 * Save chat messages + update token counts for a Studio (workspace
 * member) chat. Message count is already reserved atomically before
 * the AI call via `incrementAgentUsageIfAllowed`; this function only
 * persists messages and bumps the token metadata on the row that the
 * reservation created.
 *
 * Persistence is per-turn batched: every iteration of the tool loop
 * becomes its own row pair (assistant + tool_result) sharing the
 * single `turn_id` allocated below, so resume reads can reconstruct
 * the Anthropic protocol shape Claude saw on prior turns. Quota is
 * unaffected — `agent_usage.message_count` increments exactly once
 * per POST via the reservation step.
 *
 * Conversation API has its own actor model (key-keyed, not
 * user-keyed) and a dedicated `api_message_usage` table — use
 * `saveApiChatResult`.
 */
export async function saveChatResult(input: {
  conversationId: string
  userMessage: string
  userContentBlocks?: AIContentBlock[]
  iterations: IterationTrace[]
  lastAssistantContent: AIContentBlock[]
  model: string
  inputTokens: number
  outputTokens: number
  cacheCreationInputTokens: number
  cacheReadInputTokens: number
  workspaceId: string
  userId: string
  usageSource: 'byoa' | 'studio'
  usageMonth: string
}) {
  const db = useDatabaseProvider()

  const rows = buildTraceRows({
    conversationId: input.conversationId,
    userMessage: input.userMessage,
    userContentBlocks: input.userContentBlocks,
    trace: input.iterations,
    lastAssistantContent: input.lastAssistantContent,
    model: input.model,
    inputTokens: input.inputTokens,
    outputTokens: input.outputTokens,
    cacheCreationInputTokens: input.cacheCreationInputTokens,
    cacheReadInputTokens: input.cacheReadInputTokens,
  })

  try {
    await db.insertMessages(rows)
  }
  catch (err) {
    // eslint-disable-next-line no-console
    console.error('[chat-persist] Failed to insert chat trace:', err)
    throw err
  }

  await db.updateAgentUsageTokens({
    workspaceId: input.workspaceId,
    userId: input.userId,
    month: input.usageMonth,
    source: input.usageSource,
    inputTokens: input.inputTokens,
    outputTokens: input.outputTokens,
    cacheCreationInputTokens: input.cacheCreationInputTokens,
    cacheReadInputTokens: input.cacheReadInputTokens,
  })

  await db.updateConversationTimestamp(input.conversationId)
}

/**
 * Save chat messages + update token counts for a Conversation API
 * chat. The actor here is an API key (no workspace member identity),
 * so usage flows through `api_message_usage` instead of `agent_usage`.
 */
export async function saveApiChatResult(input: {
  conversationId: string
  userMessage: string
  iterations: IterationTrace[]
  lastAssistantContent: AIContentBlock[]
  model: string
  inputTokens: number
  outputTokens: number
  cacheCreationInputTokens: number
  cacheReadInputTokens: number
  workspaceId: string
  apiKeyId: string
  usageMonth: string
}) {
  const db = useDatabaseProvider()

  const rows = buildTraceRows({
    conversationId: input.conversationId,
    userMessage: input.userMessage,
    trace: input.iterations,
    lastAssistantContent: input.lastAssistantContent,
    model: input.model,
    inputTokens: input.inputTokens,
    outputTokens: input.outputTokens,
    cacheCreationInputTokens: input.cacheCreationInputTokens,
    cacheReadInputTokens: input.cacheReadInputTokens,
  })

  try {
    await db.insertMessages(rows)
  }
  catch (err) {
    // eslint-disable-next-line no-console
    console.error('[chat-persist] Failed to insert API chat trace:', err)
    throw err
  }

  await db.updateAPIUsageTokens({
    workspaceId: input.workspaceId,
    apiKeyId: input.apiKeyId,
    month: input.usageMonth,
    inputTokens: input.inputTokens,
    outputTokens: input.outputTokens,
    cacheCreationInputTokens: input.cacheCreationInputTokens,
    cacheReadInputTokens: input.cacheReadInputTokens,
  })

  await db.updateConversationTimestamp(input.conversationId)
}

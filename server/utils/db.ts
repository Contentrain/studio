import type { GitProvider } from '../providers/git'
import { normalizeContentRoot } from './content-paths'

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

  const project = await db.getProjectById(projectId, 'id, repo_full_name, content_root, workspace_id, default_branch, detected_stack, status')
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
  catch {
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
        emailProvider.sendEmail({
          to: email,
          subject: `You've been added to ${context.workspaceName} on Contentrain Studio`,
          html: `<p>Hi,</p><p><strong>${context.inviterName}</strong> added you to the <strong>${context.workspaceName}</strong> workspace on Contentrain Studio.</p><p><a href="${workspaceUrl}">Open workspace</a></p>`,
        }).catch(() => { /* best-effort notification */ })
      }
    }

    return { userId: existing.id, isNewUser: false }
  }
}

// ─── Cross-domain: Chat Persistence ───

/**
 * Save chat messages + update token counts.
 * Message count is already reserved atomically before the chat via
 * incrementAgentUsageIfAllowed — this function only persists messages
 * and updates the token metadata on the existing usage row.
 */
export async function saveChatResult(
  conversationId: string,
  userMessage: string,
  assistantText: string,
  assistantContent: unknown[],
  model: string,
  inputTokens: number,
  outputTokens: number,
  workspaceId: string,
  userId: string,
  usageSource: 'byoa' | 'studio' | 'api',
  usageMonth: string,
  _apiKeyId?: string,
) {
  const db = useDatabaseProvider()

  await db.insertMessage({ conversationId, role: 'user', content: userMessage })

  await db.insertMessage({
    conversationId,
    role: 'assistant',
    content: assistantText || '[tool calls]',
    toolCalls: assistantContent.length > 0 ? assistantContent : null,
    tokenCountInput: inputTokens,
    tokenCountOutput: outputTokens,
    model,
  })

  // Token counts only — message_count already reserved atomically
  await db.updateAgentUsageTokens({
    workspaceId,
    userId,
    month: usageMonth,
    source: usageSource,
    inputTokens,
    outputTokens,
  })

  await db.updateConversationTimestamp(conversationId)
}

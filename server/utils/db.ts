import type { SupabaseClient } from '@supabase/supabase-js'
import type { GitProvider } from '../providers/git'
import { normalizeContentRoot } from './content-paths'

/**
 * Database helper layer.
 *
 * Centralizes all Supabase queries so that:
 * 1. Route handlers stay lean (1-line call vs 15-line boilerplate)
 * 2. Supabase client usage is confined to this file + supabase.ts
 * 3. Future DB provider swap (Drizzle, Prisma, plain pg) changes ONE file
 *
 * NOTE: All helpers accept a SupabaseClient — they don't create one.
 * The caller (route handler) decides which client (user vs admin).
 */

// ─── Types ───

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

// ─── Project + Workspace Resolution ───

/**
 * Resolve project, workspace, and GitProvider in one call.
 * Used by ~10 routes that need to read/write content via Git.
 *
 * Throws 404 if project not found, 400 if GitHub App not installed.
 */
export async function resolveProjectContext(
  client: SupabaseClient,
  workspaceId: string,
  projectId: string,
): Promise<ProjectContext> {
  const { data: project } = await client
    .from('projects')
    .select('id, repo_full_name, content_root, workspace_id, default_branch, detected_stack, status')
    .eq('id', projectId)
    .eq('workspace_id', workspaceId)
    .single()

  if (!project)
    throw createError({ statusCode: 404, message: errorMessage('project.not_found') })

  const { data: workspace } = await client
    .from('workspaces')
    .select('id, github_installation_id, plan, slug, name, owner_id')
    .eq('id', workspaceId)
    .single()

  if (!workspace?.github_installation_id)
    throw createError({ statusCode: 400, message: errorMessage('github.installation_missing') })

  const [owner, repo] = project.repo_full_name.split('/')
  const git = useGitProvider({
    installationId: workspace.github_installation_id,
    owner,
    repo,
  })

  const contentRoot = normalizeContentRoot(project.content_root)

  return { project, workspace, git, contentRoot }
}

// ─── Workspace Queries ───

/**
 * List workspaces the user is a member of (RLS-filtered).
 */
export async function listUserWorkspaces(client: SupabaseClient) {
  // Two-step query to avoid RLS recursion:
  // 1. Get user's workspace IDs from workspace_members (terminal RLS: own rows only)
  // 2. Get workspace details by IDs
  const { data: memberships } = await client
    .from('workspace_members')
    .select('workspace_id, role')

  if (!memberships?.length) {
    // Fallback: check owned workspaces directly
    const { data, error } = await client
      .from('workspaces')
      .select('*')
      .order('created_at', { ascending: true })
    if (error) throw createError({ statusCode: 500, message: error.message })
    return (data ?? []).map(w => ({ ...w, workspace_members: [{ role: 'owner' }] }))
  }

  const wsIds = memberships.map(m => m.workspace_id)
  const roleMap = Object.fromEntries(memberships.map(m => [m.workspace_id, m.role]))

  const { data, error } = await client
    .from('workspaces')
    .select('*')
    .in('id', wsIds)
    .order('created_at', { ascending: true })

  if (error) throw createError({ statusCode: 500, message: error.message })

  return (data ?? []).map(w => ({
    ...w,
    workspace_members: [{ role: roleMap[w.id] ?? 'member' }],
  }))
}

/**
 * Get a single workspace by ID (RLS-filtered).
 */
export async function getWorkspace(client: SupabaseClient, workspaceId: string) {
  const { data, error } = await client
    .from('workspaces')
    .select('*')
    .eq('id', workspaceId)
    .single()

  if (error)
    throw createError({ statusCode: 500, message: error.message })

  return data
}

/**
 * Find the user's primary workspace (first by creation date).
 */
export async function getPrimaryWorkspace(client: SupabaseClient, ownerId: string) {
  const { data } = await client
    .from('workspaces')
    .select('id, slug, github_installation_id')
    .eq('owner_id', ownerId)
    .order('created_at', { ascending: true })
    .limit(1)
    .single()

  return data
}

// ─── Role Authorization ───

/**
 * Verify the caller has one of the required workspace roles.
 * Throws 403 if not authorized.
 */
export async function requireWorkspaceRole(
  client: SupabaseClient,
  userId: string,
  workspaceId: string,
  requiredRoles: string[],
): Promise<string> {
  const { data } = await client
    .from('workspace_members')
    .select('role')
    .eq('workspace_id', workspaceId)
    .eq('user_id', userId)
    .single()

  if (!data || !requiredRoles.includes(data.role))
    throw createError({ statusCode: 403, message: errorMessage('members.requires_role', { roles: requiredRoles.join(' or ') }) })

  return data.role
}

// ─── Member Queries ───

const WORKSPACE_MEMBER_SELECT = `
  id, role, user_id, invited_email, invited_at, accepted_at,
  profiles:user_id(id, display_name, email, avatar_url)
`

const PROJECT_MEMBER_SELECT = `
  id, role, user_id, specific_models, allowed_models, invited_email, invited_at, accepted_at,
  profiles:user_id(id, display_name, email, avatar_url)
`

/**
 * List workspace members with profile data.
 */
export async function listWorkspaceMembers(client: SupabaseClient, workspaceId: string): Promise<MemberRow[]> {
  const { data, error } = await client
    .from('workspace_members')
    .select(WORKSPACE_MEMBER_SELECT)
    .eq('workspace_id', workspaceId)
    .order('invited_at', { ascending: true })

  if (error)
    throw createError({ statusCode: 500, message: error.message })

  return (data ?? []) as unknown as MemberRow[]
}

/**
 * List project members with profile data.
 */
export async function listProjectMembers(client: SupabaseClient, projectId: string): Promise<MemberRow[]> {
  const { data, error } = await client
    .from('project_members')
    .select(PROJECT_MEMBER_SELECT)
    .eq('project_id', projectId)
    .order('invited_at', { ascending: true })

  if (error)
    throw createError({ statusCode: 500, message: error.message })

  return (data ?? []) as unknown as MemberRow[]
}

// ─── Invitation Flow ───

/**
 * Invite a user by email — creates account if needed, returns userId.
 * Falls back to user lookup if invite fails (already exists).
 * Sends notification email to existing users via EmailProvider.
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
    // User already exists — look up by email
    const admin = useSupabaseAdmin()
    const { data: users } = await admin.auth.admin.listUsers()
    const existing = users?.users?.find((u: { email?: string }) => u.email === email)
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

/**
 * Ensure a user is a workspace member. If not, add them (requires admin client).
 */
export async function ensureWorkspaceMember(
  userClient: SupabaseClient,
  adminClient: SupabaseClient,
  workspaceId: string,
  userId: string,
  email: string,
  role: string = 'member',
): Promise<void> {
  // Check existing membership (user client for RLS)
  const { data: existing } = await userClient
    .from('workspace_members')
    .select('id')
    .eq('workspace_id', workspaceId)
    .eq('user_id', userId)
    .single()

  if (existing) return

  // Add via admin to bypass RLS
  await adminClient
    .from('workspace_members')
    .insert({
      workspace_id: workspaceId,
      user_id: userId,
      role,
      invited_email: email,
      invited_at: new Date().toISOString(),
      accepted_at: null,
    })
}

// ─── Chat & Usage ───

/**
 * Load conversation history (last N messages).
 */
export async function loadConversationHistory(
  client: SupabaseClient,
  conversationId: string,
  limit: number = 20,
) {
  const { data } = await client
    .from('messages')
    .select('role, content, tool_calls')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: true })
    .limit(limit)

  return data ?? []
}

/**
 * Create a new conversation.
 */
export async function createConversation(
  client: SupabaseClient,
  projectId: string,
  userId: string,
  title: string,
): Promise<string | null> {
  const { data } = await client
    .from('conversations')
    .insert({
      project_id: projectId,
      user_id: userId,
      title: title.substring(0, 100),
    })
    .select('id')
    .single()

  return data?.id ?? null
}

/**
 * Save chat messages + track usage (admin client, bypasses RLS).
 */
export async function saveChatResult(
  admin: SupabaseClient,
  conversationId: string,
  userMessage: string,
  assistantText: string,
  assistantContent: unknown[],
  model: string,
  inputTokens: number,
  outputTokens: number,
  workspaceId: string,
  userId: string,
  usageSource: 'byoa' | 'studio',
) {
  // Save user message
  await admin.from('messages').insert({
    conversation_id: conversationId,
    role: 'user',
    content: userMessage,
  })

  // Save assistant message
  await admin.from('messages').insert({
    conversation_id: conversationId,
    role: 'assistant',
    content: assistantText || '[tool calls]',
    tool_calls: assistantContent.length > 0 ? assistantContent : null,
    token_count_input: inputTokens,
    token_count_output: outputTokens,
    model,
  })

  // Update usage — increment counters, not overwrite
  const month = new Date().toISOString().substring(0, 7)
  const { data: existing } = await admin
    .from('agent_usage')
    .select('id, message_count, input_tokens, output_tokens')
    .eq('workspace_id', workspaceId)
    .eq('user_id', userId)
    .eq('month', month)
    .eq('source', usageSource)
    .single()

  if (existing) {
    await admin.from('agent_usage').update({
      message_count: (existing.message_count ?? 0) + 1,
      input_tokens: (existing.input_tokens ?? 0) + inputTokens,
      output_tokens: (existing.output_tokens ?? 0) + outputTokens,
      updated_at: new Date().toISOString(),
    }).eq('id', existing.id)
  }
  else {
    await admin.from('agent_usage').insert({
      workspace_id: workspaceId,
      user_id: userId,
      month,
      source: usageSource,
      message_count: 1,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
    })
  }

  // Update conversation timestamp
  await admin.from('conversations').update({
    updated_at: new Date().toISOString(),
  }).eq('id', conversationId)
}

// ─── BYOA Key ───

/**
 * Look up user's BYOA API key for a workspace.
 */
export async function getBYOAKey(
  client: SupabaseClient,
  workspaceId: string,
  userId: string,
): Promise<string | null> {
  const { data } = await client
    .from('ai_keys')
    .select('encrypted_key')
    .eq('workspace_id', workspaceId)
    .eq('user_id', userId)
    .eq('provider', 'anthropic')
    .single()

  return data?.encrypted_key ?? null
}

// ─── Media Assets ───

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

export async function createMediaAsset(
  admin: SupabaseClient,
  asset: Omit<MediaAssetRow, 'id' | 'created_at' | 'updated_at'>,
): Promise<MediaAssetRow> {
  const { data, error } = await admin
    .from('media_assets')
    .insert(asset)
    .select()
    .single()

  if (error || !data)
    throw createError({ statusCode: 500, message: errorMessage('media.create_failed', { detail: error?.message ?? 'Unknown error' }) })

  return data as MediaAssetRow
}

export async function getMediaAsset(
  client: SupabaseClient,
  assetId: string,
): Promise<MediaAssetRow | null> {
  const { data } = await client
    .from('media_assets')
    .select('*')
    .eq('id', assetId)
    .single()

  return (data as MediaAssetRow) ?? null
}

export async function listMediaAssets(
  client: SupabaseClient,
  projectId: string,
  options?: { search?: string, tags?: string[], contentType?: string, page?: number, limit?: number, sort?: string },
): Promise<{ assets: MediaAssetRow[], total: number }> {
  const page = options?.page ?? 1
  const limit = options?.limit ?? 50
  const offset = (page - 1) * limit

  let query = client
    .from('media_assets')
    .select('*', { count: 'exact' })
    .eq('project_id', projectId)

  if (options?.search) {
    query = query.or(`filename.ilike.%${options.search}%,alt.ilike.%${options.search}%`)
  }

  if (options?.tags?.length) {
    query = query.overlaps('tags', options.tags)
  }

  if (options?.contentType) {
    query = query.ilike('content_type', `${options.contentType}%`)
  }

  const sortColumn = options?.sort === 'name' ? 'filename' : options?.sort === 'size' ? 'size_bytes' : 'created_at'
  const ascending = options?.sort === 'name' || options?.sort === 'oldest'

  const { data, count, error } = await query
    .order(sortColumn, { ascending })
    .range(offset, offset + limit - 1)

  if (error)
    throw createError({ statusCode: 500, message: errorMessage('media.list_failed', { detail: error.message }) })

  return { assets: (data ?? []) as MediaAssetRow[], total: count ?? 0 }
}

export async function updateMediaAsset(
  admin: SupabaseClient,
  assetId: string,
  updates: Partial<Pick<MediaAssetRow, 'alt' | 'tags' | 'focal_point' | 'variants' | 'blurhash'>>,
): Promise<MediaAssetRow> {
  const { data, error } = await admin
    .from('media_assets')
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq('id', assetId)
    .select()
    .single()

  if (error || !data)
    throw createError({ statusCode: 500, message: errorMessage('media.update_failed', { detail: error?.message ?? 'Unknown error' }) })

  return data as MediaAssetRow
}

export async function deleteMediaAsset(
  admin: SupabaseClient,
  assetId: string,
): Promise<MediaAssetRow | null> {
  const { data } = await admin
    .from('media_assets')
    .delete()
    .eq('id', assetId)
    .select()
    .single()

  return (data as MediaAssetRow) ?? null
}

export async function trackMediaUsage(
  admin: SupabaseClient,
  usage: { asset_id: string, project_id: string, model_id: string, entry_id: string, field_id: string, locale: string },
): Promise<void> {
  await admin
    .from('media_usage')
    .upsert(usage, { onConflict: 'asset_id,model_id,entry_id,field_id,locale' })
}

export async function removeMediaUsage(
  admin: SupabaseClient,
  usage: { asset_id: string, model_id: string, entry_id: string, field_id: string, locale: string },
): Promise<void> {
  await admin
    .from('media_usage')
    .delete()
    .eq('asset_id', usage.asset_id)
    .eq('model_id', usage.model_id)
    .eq('entry_id', usage.entry_id)
    .eq('field_id', usage.field_id)
    .eq('locale', usage.locale)
}

export async function getMediaUsage(
  client: SupabaseClient,
  assetId: string,
): Promise<Array<{ model_id: string, entry_id: string, field_id: string, locale: string }>> {
  const { data } = await client
    .from('media_usage')
    .select('model_id, entry_id, field_id, locale')
    .eq('asset_id', assetId)

  return data ?? []
}

export async function updateWorkspaceStorageBytes(
  admin: SupabaseClient,
  workspaceId: string,
  deltaBytes: number,
): Promise<void> {
  // Use RPC or raw SQL for atomic increment — fallback to read+write
  const { data } = await admin
    .from('workspaces')
    .select('media_storage_bytes')
    .eq('id', workspaceId)
    .single()

  const current = (data as { media_storage_bytes: number } | null)?.media_storage_bytes ?? 0
  const newValue = Math.max(0, current + deltaBytes)

  await admin
    .from('workspaces')
    .update({ media_storage_bytes: newValue })
    .eq('id', workspaceId)
}

// ============================================================
// FORM SUBMISSIONS
// ============================================================

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

export async function createFormSubmission(
  admin: SupabaseClient,
  submission: FormSubmissionInsert,
): Promise<FormSubmissionRow> {
  const { data, error } = await admin
    .from('form_submissions')
    .insert(submission)
    .select()
    .single()

  if (error || !data)
    throw createError({ statusCode: 500, message: errorMessage('forms.create_failed', { detail: error?.message ?? 'unknown' }) })

  return data as FormSubmissionRow
}

export async function listFormSubmissions(
  admin: SupabaseClient,
  workspaceId: string,
  projectId: string,
  modelId: string,
  options?: { page?: number, limit?: number, status?: string, sort?: 'newest' | 'oldest' },
): Promise<{ submissions: FormSubmissionRow[], total: number }> {
  const page = options?.page ?? 1
  const limit = Math.min(options?.limit ?? 50, 100)
  const offset = (page - 1) * limit

  let query = admin
    .from('form_submissions')
    .select('*', { count: 'exact' })
    .eq('workspace_id', workspaceId)
    .eq('project_id', projectId)
    .eq('model_id', modelId)

  if (options?.status) {
    query = query.eq('status', options.status)
  }

  query = options?.sort === 'oldest'
    ? query.order('created_at', { ascending: true })
    : query.order('created_at', { ascending: false })

  const { data, count, error } = await query.range(offset, offset + limit - 1)

  if (error)
    throw createError({ statusCode: 500, message: errorMessage('forms.list_failed', { detail: error.message }) })

  return {
    submissions: (data ?? []) as FormSubmissionRow[],
    total: count ?? 0,
  }
}

export async function getFormSubmission(
  admin: SupabaseClient,
  submissionId: string,
): Promise<FormSubmissionRow | null> {
  const { data } = await admin
    .from('form_submissions')
    .select('*')
    .eq('id', submissionId)
    .single()

  return (data as FormSubmissionRow) ?? null
}

export async function updateFormSubmissionStatus(
  admin: SupabaseClient,
  submissionId: string,
  status: 'approved' | 'rejected' | 'spam',
  approvedBy?: string,
  entryId?: string,
): Promise<FormSubmissionRow> {
  const updates: Record<string, unknown> = { status }
  if (status === 'approved') {
    updates.approved_at = new Date().toISOString()
    if (approvedBy) updates.approved_by = approvedBy
    if (entryId) updates.entry_id = entryId
  }

  const { data, error } = await admin
    .from('form_submissions')
    .update(updates)
    .eq('id', submissionId)
    .select()
    .single()

  if (error || !data)
    throw createError({ statusCode: 500, message: errorMessage('forms.update_failed', { detail: error?.message ?? 'unknown' }) })

  return data as FormSubmissionRow
}

export async function countMonthlySubmissions(
  admin: SupabaseClient,
  projectId: string,
): Promise<number> {
  const now = new Date()
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))

  const { count } = await admin
    .from('form_submissions')
    .select('*', { count: 'exact', head: true })
    .eq('project_id', projectId)
    .gte('created_at', monthStart.toISOString())

  return count ?? 0
}

export async function deleteFormSubmission(
  admin: SupabaseClient,
  submissionId: string,
): Promise<void> {
  const { error } = await admin
    .from('form_submissions')
    .delete()
    .eq('id', submissionId)

  if (error)
    throw createError({ statusCode: 500, message: errorMessage('forms.delete_failed', { detail: error.message }) })
}

export async function bulkUpdateSubmissions(
  admin: SupabaseClient,
  submissionIds: string[],
  status: 'approved' | 'rejected' | 'spam',
  approvedBy?: string,
  projectId?: string,
  modelId?: string,
): Promise<number> {
  const updates: Record<string, unknown> = { status }
  if (status === 'approved') {
    updates.approved_at = new Date().toISOString()
    if (approvedBy) updates.approved_by = approvedBy
  }

  let query = admin
    .from('form_submissions')
    .update(updates)
    .in('id', submissionIds)

  // Scope to project/model to prevent cross-workspace tampering
  if (projectId) query = query.eq('project_id', projectId)
  if (modelId) query = query.eq('model_id', modelId)

  const { data } = await query.select('id')

  return data?.length ?? 0
}

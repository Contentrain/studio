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
    throw createError({ statusCode: 404, message: 'Project not found' })

  const { data: workspace } = await client
    .from('workspaces')
    .select('id, github_installation_id, plan, slug, name, owner_id')
    .eq('id', workspaceId)
    .single()

  if (!workspace?.github_installation_id)
    throw createError({ statusCode: 400, message: 'GitHub App not installed' })

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
    throw createError({ statusCode: 403, message: `Requires ${requiredRoles.join(' or ')} role` })

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
 */
export async function inviteOrLookupUser(email: string): Promise<string> {
  const authProvider = useAuthProvider()

  try {
    const result = await authProvider.inviteUserByEmail(email)
    return result.userId
  }
  catch {
    // User might already exist — look up by email
    const admin = useSupabaseAdmin()
    const { data: users } = await admin.auth.admin.listUsers()
    const existing = users?.users?.find((u: { email?: string }) => u.email === email)
    if (!existing?.id)
      throw createError({ statusCode: 400, message: 'Could not find or invite user' })
    return existing.id
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

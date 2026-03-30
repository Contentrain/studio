/**
 * Resolve user permissions for chat agent tool filtering.
 *
 * Two-tier: workspace role → project role.
 * Workspace owner/admin → full access to all tools.
 * Workspace member → check project_members for project-level role.
 *
 * EE gating: reviewer/viewer roles and specificModels require
 * 'roles.reviewer' / 'roles.viewer' / 'roles.specific_models' features.
 * Free tier degrades gracefully: reviewer/viewer → editor.
 */

import { getWorkspacePlan } from './license'
import { normalizeEnterpriseProjectMemberAccess } from './enterprise'

export interface AgentPermissions {
  workspaceRole: 'owner' | 'admin' | 'member'
  projectRole: 'editor' | 'reviewer' | 'viewer' | null
  specificModels: boolean
  allowedModels: string[]
  allowedLocales: string[]
  availableTools: string[]
}

// Tool → minimum role required
const TOOL_ROLES: Record<string, string[]> = {
  list_models: ['viewer', 'reviewer', 'editor', 'admin', 'owner'],
  get_content: ['viewer', 'reviewer', 'editor', 'admin', 'owner'],
  save_content: ['editor', 'admin', 'owner'],
  delete_content: ['editor', 'admin', 'owner'],
  save_model: ['admin', 'owner'],
  validate: ['viewer', 'reviewer', 'editor', 'admin', 'owner'],
  list_branches: ['viewer', 'reviewer', 'editor', 'admin', 'owner'],
  merge_branch: ['reviewer', 'admin', 'owner'],
  reject_branch: ['reviewer', 'admin', 'owner'],
  init_project: ['admin', 'owner'],
  copy_locale: ['editor', 'admin', 'owner'],
  brain_query: ['viewer', 'reviewer', 'editor', 'admin', 'owner'],
  brain_search: ['viewer', 'reviewer', 'editor', 'admin', 'owner'],
  brain_analyze: ['viewer', 'reviewer', 'editor', 'admin', 'owner'],
  validate_schema: ['viewer', 'reviewer', 'editor', 'admin', 'owner'],
  search_media: ['viewer', 'reviewer', 'editor', 'admin', 'owner'],
  upload_media: ['editor', 'admin', 'owner'],
  get_media: ['viewer', 'reviewer', 'editor', 'admin', 'owner'],
  list_submissions: ['viewer', 'reviewer', 'editor', 'admin', 'owner'],
  approve_submission: ['reviewer', 'admin', 'owner'],
  reject_submission: ['reviewer', 'admin', 'owner'],
}

export async function resolveAgentPermissions(
  userId: string,
  workspaceId: string,
  projectId: string,
  accessToken: string,
): Promise<AgentPermissions> {
  const client = useDatabaseProvider().getUserClient(accessToken)

  // Get workspace role + plan
  const { data: wsMember } = await client
    .from('workspace_members')
    .select('role')
    .eq('workspace_id', workspaceId)
    .eq('user_id', userId)
    .single()

  const workspaceRole = (wsMember?.role ?? 'member') as AgentPermissions['workspaceRole']

  // Workspace owner/admin → full access (regardless of plan)
  if (workspaceRole === 'owner' || workspaceRole === 'admin') {
    return {
      workspaceRole,
      projectRole: null,
      specificModels: false,
      allowedModels: [],
      allowedLocales: [],
      availableTools: Object.keys(TOOL_ROLES),
    }
  }

  // Workspace member → check project role
  const { data: projMember } = await client
    .from('project_members')
    .select('role, specific_models, allowed_models')
    .eq('project_id', projectId)
    .eq('user_id', userId)
    .single()

  if (!projMember) {
    return {
      workspaceRole,
      projectRole: null,
      specificModels: false,
      allowedModels: [],
      allowedLocales: [],
      availableTools: [],
    }
  }

  // Resolve workspace plan for EE feature gating
  const { data: workspace } = await client
    .from('workspaces')
    .select('plan')
    .eq('id', workspaceId)
    .single()

  const plan = getWorkspacePlan(workspace ?? {})

  const normalizedAccess = await normalizeEnterpriseProjectMemberAccess({
    plan,
    role: projMember.role as AgentPermissions['projectRole'],
    specificModels: projMember.specific_models ?? false,
    allowedModels: projMember.allowed_models ?? [],
  })

  const projectRole = normalizedAccess.role as AgentPermissions['projectRole']

  const effectiveRole = projectRole ?? 'viewer'

  // Filter tools by effective role
  const availableTools = Object.entries(TOOL_ROLES)
    .filter(([_, roles]) => roles.includes(effectiveRole))
    .map(([name]) => name)

  return {
    workspaceRole,
    projectRole,
    specificModels: normalizedAccess.specificModels,
    allowedModels: normalizedAccess.allowedModels,
    allowedLocales: [],
    availableTools,
  }
}

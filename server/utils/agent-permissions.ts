/**
 * Resolve user permissions for chat agent tool filtering.
 *
 * Two-tier: workspace role → project role.
 * Workspace owner/admin → full access to all tools.
 * Workspace member → check project_members for project-level role.
 */

export interface AgentPermissions {
  workspaceRole: 'owner' | 'admin' | 'member'
  projectRole: 'editor' | 'reviewer' | 'viewer' | null
  specificModels: boolean
  allowedModels: string[]
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
}

export async function resolveAgentPermissions(
  userId: string,
  workspaceId: string,
  projectId: string,
  accessToken: string,
): Promise<AgentPermissions> {
  const client = useSupabaseUserClient(accessToken)

  // Get workspace role
  const { data: wsMember } = await client
    .from('workspace_members')
    .select('role')
    .eq('workspace_id', workspaceId)
    .eq('user_id', userId)
    .single()

  const workspaceRole = (wsMember?.role ?? 'member') as AgentPermissions['workspaceRole']

  // Workspace owner/admin → full access
  if (workspaceRole === 'owner' || workspaceRole === 'admin') {
    return {
      workspaceRole,
      projectRole: null,
      specificModels: false,
      allowedModels: [],
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
    // No project access
    return {
      workspaceRole,
      projectRole: null,
      specificModels: false,
      allowedModels: [],
      availableTools: [],
    }
  }

  const projectRole = projMember.role as AgentPermissions['projectRole']
  const effectiveRole = projectRole ?? 'viewer'

  // Filter tools by role
  const availableTools = Object.entries(TOOL_ROLES)
    .filter(([_, roles]) => roles.includes(effectiveRole))
    .map(([name]) => name)

  return {
    workspaceRole,
    projectRole,
    specificModels: projMember.specific_models ?? false,
    allowedModels: projMember.allowed_models ?? [],
    availableTools,
  }
}

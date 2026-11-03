/**
 * Permissions of the person an MCP Cloud call acts for.
 *
 * The UI and chat resolve permissions from the session (`resolveAgentPermissions`,
 * which reads the workspace role through the user's own token). An MCP Cloud
 * call carries no session: it acts for an OAuth grant's user or for an API
 * key's creator. This resolver reads the same two tiers without a token, at
 * call time, so a member who was removed or demoted after the grant or the key
 * was made loses what the new role does not allow.
 *
 * Fail closed: no actor (a key whose creator was deleted), or no accepted
 * workspace membership, is `null` — the caller refuses every write.
 */
import type { AgentPermissions } from './agent-permissions'
import { TOOL_ROLES } from './agent-permissions'
import { normalizeEnterpriseProjectMemberAccess } from './enterprise'
import { getWorkspacePlan } from './license'
import { useDatabaseProvider } from './providers'

export async function resolveMcpActorPermissions(
  userId: string | null,
  workspaceId: string,
  projectId: string,
): Promise<AgentPermissions | null> {
  if (!userId) return null
  const db = useDatabaseProvider()

  const role = await db.getAcceptedWorkspaceRole(workspaceId, userId)
  if (role !== 'owner' && role !== 'admin' && role !== 'member') return null

  if (role === 'owner' || role === 'admin') {
    return {
      workspaceRole: role,
      projectRole: null,
      specificModels: false,
      allowedModels: [],
      allowedLocales: [],
      availableTools: Object.keys(TOOL_ROLES),
    }
  }

  const projMember = await db.getProjectMember(projectId, userId)
  if (!projMember) return null

  const workspace = await db.getWorkspaceById(workspaceId, 'plan')
  const normalizedAccess = await normalizeEnterpriseProjectMemberAccess({
    plan: getWorkspacePlan(workspace ?? {}),
    role: (projMember.role as string) as AgentPermissions['projectRole'],
    specificModels: (projMember.specific_models as boolean) ?? false,
    allowedModels: (projMember.allowed_models as string[]) ?? [],
  })

  const projectRole = normalizedAccess.role as AgentPermissions['projectRole']
  const effectiveRole = projectRole ?? 'viewer'

  return {
    workspaceRole: role,
    projectRole,
    specificModels: normalizedAccess.specificModels,
    allowedModels: normalizedAccess.allowedModels,
    allowedLocales: [],
    availableTools: Object.entries(TOOL_ROLES)
      .filter(([, roles]) => roles.includes(effectiveRole))
      .map(([name]) => name),
  }
}

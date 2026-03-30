import type { SupabaseClient } from '@supabase/supabase-js'

export type DatabaseRow = Record<string, unknown>
export type DatabaseQueryChain = ReturnType<SupabaseClient['from']>
export type DatabaseClientBridge = SupabaseClient

export interface DatabaseProvider {
  // Internal bridge for legacy helper functions during the adapter migration.
  getAdminClient: () => DatabaseClientBridge
  getUserClient: (accessToken: string) => DatabaseClientBridge

  listUserWorkspaces: (accessToken: string, userId: string) => Promise<DatabaseRow[]>
  createWorkspace: (accessToken: string, input: {
    name: string
    slug: string
    ownerId: string
    type: 'primary' | 'secondary'
  }) => Promise<DatabaseRow>
  getWorkspaceForUser: (
    accessToken: string,
    userId: string,
    workspaceId: string,
    requiredRoles?: string[],
    fields?: string,
  ) => Promise<DatabaseRow | null>
  getWorkspaceDetailForUser: (accessToken: string, userId: string, workspaceId: string) => Promise<DatabaseRow | null>
  getWorkspaceById: (workspaceId: string, fields?: string) => Promise<DatabaseRow | null>
  updateWorkspace: (accessToken: string, workspaceId: string, updates: Record<string, unknown>, fields?: string) => Promise<DatabaseRow>
  updateWorkspaceForUser: (
    accessToken: string,
    userId: string,
    workspaceId: string,
    updates: Record<string, unknown>,
    fields?: string,
  ) => Promise<DatabaseRow>
  getPrimaryWorkspace: (accessToken: string, ownerId: string) => Promise<DatabaseRow | null>
  requireWorkspaceRole: (accessToken: string, userId: string, workspaceId: string, requiredRoles: string[]) => Promise<string>
  findWorkspaceByGithubInstallation: (installationId: number, excludeWorkspaceId?: string) => Promise<DatabaseRow | null>
  updateWorkspaceGithubInstallation: (workspaceId: string, installationId: number) => Promise<void>

  listWorkspaceMembers: (accessToken: string, userId: string, workspaceId: string) => Promise<DatabaseRow[]>
  getWorkspaceMember: (accessToken: string, userId: string, workspaceId: string, memberId: string) => Promise<DatabaseRow | null>
  createWorkspaceMember: (accessToken: string, userId: string, input: {
    workspaceId: string
    memberUserId: string
    role: 'admin' | 'member'
    invitedEmail: string
    acceptedAt?: string | null
  }) => Promise<DatabaseRow>
  updateWorkspaceMemberRole: (accessToken: string, userId: string, workspaceId: string, memberId: string, role: 'admin' | 'member') => Promise<DatabaseRow>
  deleteWorkspaceMember: (accessToken: string, userId: string, workspaceId: string, memberId: string) => Promise<void>
  updateWorkspaceMemberInvitedAt: (accessToken: string, userId: string, workspaceId: string, memberId: string, invitedAt: string) => Promise<void>

  listUserAIKeys: (accessToken: string, workspaceId: string, userId: string) => Promise<DatabaseRow[]>
  upsertUserAIKey: (accessToken: string, input: {
    workspaceId: string
    userId: string
    provider: string
    encryptedKey: string
    keyHint: string
  }) => Promise<DatabaseRow>
  deleteUserAIKey: (accessToken: string, workspaceId: string, keyId: string, userId: string) => Promise<void>

  getProjectForWorkspace: (accessToken: string, workspaceId: string, projectId: string, fields?: string) => Promise<DatabaseRow | null>
  countProjectWebhooks: (projectId: string, workspaceId: string) => Promise<number>
  createWebhook: (input: {
    workspaceId: string
    projectId: string
    name: string
    url: string
    events: string[]
    secret: string
  }) => Promise<DatabaseRow>
}

export type DatabaseRow = Record<string, unknown>

// ─── Domain types ───

export interface MediaAssetInput {
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
}

export interface MediaUsageInput {
  asset_id: string
  project_id: string
  model_id: string
  entry_id: string
  field_id: string
  locale: string
}

export interface FormSubmissionInput {
  project_id: string
  workspace_id: string
  model_id: string
  data: Record<string, unknown>
  source_ip?: string
  user_agent?: string
  referrer?: string
  locale?: string
}

export interface PaginationOptions {
  page?: number
  limit?: number
}

export interface DatabaseProvider {
  // ═══════════════════════════════════════════════════
  // PROFILES
  // ═══════════════════════════════════════════════════

  getProfile: (accessToken: string, userId: string) => Promise<DatabaseRow | null>
  updateProfile: (accessToken: string, userId: string, updates: {
    display_name?: string
    avatar_url?: string | null
    theme?: 'light' | 'dark' | 'system'
  }) => Promise<DatabaseRow>

  // ═══════════════════════════════════════════════════
  // WORKSPACES
  // ═══════════════════════════════════════════════════

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
  getWorkspaceMemberRole: (accessToken: string, userId: string, workspaceId: string) => Promise<string | null>
  findWorkspaceByGithubInstallation: (installationId: number, excludeWorkspaceId?: string) => Promise<DatabaseRow | null>
  updateWorkspaceGithubInstallation: (workspaceId: string, installationId: number) => Promise<void>
  clearWorkspaceGithubInstallation: (installationId: number) => Promise<void>
  deleteWorkspace: (workspaceId: string) => Promise<void>
  incrementWorkspaceStorageBytes: (workspaceId: string, deltaBytes: number) => Promise<void>
  reserveStorageIfAllowed: (workspaceId: string, reserveBytes: number, limitBytes: number) => Promise<{ allowed: boolean, currentBytes: number }>
  transferWorkspaceOwnership: (workspaceId: string, currentOwnerId: string, newOwnerId: string) => Promise<void>
  listOwnedSecondaryWorkspacesWithMembers: (accessToken: string, ownerId: string) => Promise<DatabaseRow[]>

  // ═══════════════════════════════════════════════════
  // WORKSPACE MEMBERS
  // ═══════════════════════════════════════════════════

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
  createWorkspaceMemberIfAllowed: (input: {
    workspaceId: string
    memberUserId: string
    role: 'admin' | 'member'
    invitedEmail: string
    acceptedAt?: string | null
    limit: number
    accessToken: string
    callerUserId: string
  }) => Promise<{ allowed: boolean, currentCount: number, member?: DatabaseRow, alreadyExisted?: boolean }>
  ensureWorkspaceMember: (accessToken: string, workspaceId: string, userId: string, email: string, role?: string) => Promise<void>
  acceptPendingInvitations: (userId: string, workspaceId: string) => Promise<boolean>
  listWorkspaceAdminEmails: (workspaceId: string) => Promise<{ email: string, displayName: string | null }[]>

  // ═══════════════════════════════════════════════════
  // PROJECTS
  // ═══════════════════════════════════════════════════

  getProjectForWorkspace: (accessToken: string, workspaceId: string, projectId: string, fields?: string) => Promise<DatabaseRow | null>
  getProjectById: (projectId: string, fields?: string) => Promise<DatabaseRow | null>
  getProjectWithMembers: (accessToken: string, workspaceId: string, projectId: string) => Promise<DatabaseRow | null>
  checkDuplicateProject: (workspaceId: string, repoFullName: string) => Promise<boolean>
  createProject: (accessToken: string, input: Record<string, unknown>) => Promise<DatabaseRow>
  updateProject: (projectId: string, updates: Record<string, unknown>, fields?: string) => Promise<DatabaseRow>
  deleteProject: (projectId: string, workspaceId: string) => Promise<void>
  getProjectMediaStorageSum: (projectId: string) => Promise<number>
  listWorkspaceProjects: (accessToken: string, workspaceId: string) => Promise<DatabaseRow[]>
  listWorkspaceProjectsAdmin: (workspaceId: string) => Promise<DatabaseRow[]>
  listUserAssignedProjectIds: (userId: string) => Promise<string[]>
  listWorkspaceProjectsByIds: (workspaceId: string, projectIds: string[]) => Promise<DatabaseRow[]>
  listUserAssignedProjects: (accessToken: string, userId: string) => Promise<DatabaseRow[]>
  updateProjectContentTimestamp: (repoFullName: string) => Promise<void>
  listCDNEnabledProjects: (repoFullName: string) => Promise<DatabaseRow[]>
  listAllActiveProjects: (fields?: string) => Promise<DatabaseRow[]>

  // ═══════════════════════════════════════════════════
  // PROJECT MEMBERS
  // ═══════════════════════════════════════════════════

  listProjectMembers: (projectId: string) => Promise<DatabaseRow[]>
  getProjectMember: (projectId: string, userId: string) => Promise<DatabaseRow | null>
  createProjectMember: (input: {
    projectId: string
    workspaceId: string
    userId: string
    role: string
    invitedEmail: string
    specificModels?: boolean
    allowedModels?: string[]
  }) => Promise<DatabaseRow>
  deleteProjectMember: (projectId: string, memberId: string) => Promise<void>

  // ═══════════════════════════════════════════════════
  // AI KEYS (user's BYOA keys per workspace)
  // ═══════════════════════════════════════════════════

  listUserAIKeys: (accessToken: string, workspaceId: string, userId: string) => Promise<DatabaseRow[]>
  upsertUserAIKey: (accessToken: string, input: {
    workspaceId: string
    userId: string
    provider: string
    encryptedKey: string
    keyHint: string
  }) => Promise<DatabaseRow>
  deleteUserAIKey: (accessToken: string, workspaceId: string, keyId: string, userId: string) => Promise<void>
  getBYOAKey: (accessToken: string, workspaceId: string, userId: string) => Promise<string | null>

  // ═══════════════════════════════════════════════════
  // CONVERSATIONS
  // ═══════════════════════════════════════════════════

  createConversation: (projectId: string, userId: string, title: string) => Promise<string | null>
  getConversation: (conversationId: string, projectId: string, filters?: { userId?: string, workspaceId?: string }) => Promise<DatabaseRow | null>
  listConversations: (accessToken: string, projectId: string, userId: string) => Promise<DatabaseRow[]>
  deleteConversation: (accessToken: string, conversationId: string, userId: string, projectId: string) => Promise<void>
  updateConversationTimestamp: (conversationId: string) => Promise<void>

  // ═══════════════════════════════════════════════════
  // MESSAGES
  // ═══════════════════════════════════════════════════

  loadConversationMessages: (conversationId: string, limit?: number, fields?: string) => Promise<DatabaseRow[]>
  insertMessage: (input: {
    conversationId: string
    role: 'user' | 'assistant'
    content: string
    toolCalls?: unknown[] | null
    tokenCountInput?: number
    tokenCountOutput?: number
    model?: string
  }) => Promise<void>

  // ═══════════════════════════════════════════════════
  // AGENT USAGE
  // ═══════════════════════════════════════════════════

  getAgentUsage: (workspaceId: string, month: string, source: string, identifiers: {
    userId?: string
    apiKeyId?: string
  }) => Promise<DatabaseRow | null>
  upsertAgentUsage: (input: {
    workspaceId: string
    userId: string
    apiKeyId?: string
    month: string
    source: string
    messageCount: number
    inputTokens: number
    outputTokens: number
  }) => Promise<void>
  getMonthlyUsageSummary: (workspaceId: string, userId: string, month: string) => Promise<number>

  /** Atomic: check monthly limit + reserve a message slot. Prevents race conditions. */
  incrementAgentUsageIfAllowed: (input: {
    workspaceId: string
    userId: string
    apiKeyId?: string
    month: string
    source: string
    limit: number
  }) => Promise<{ allowed: boolean, currentCount: number }>

  /** Update token counts on an existing agent_usage row (after chat completes). */
  updateAgentUsageTokens: (input: {
    workspaceId: string
    userId: string
    month: string
    source: string
    inputTokens: number
    outputTokens: number
  }) => Promise<void>

  // ═══════════════════════════════════════════════════
  // MEDIA ASSETS
  // ═══════════════════════════════════════════════════

  createMediaAsset: (asset: MediaAssetInput) => Promise<DatabaseRow>
  getMediaAsset: (assetId: string) => Promise<DatabaseRow | null>
  listMediaAssets: (projectId: string, options?: PaginationOptions & {
    search?: string
    tags?: string[]
    contentType?: string
    sort?: string
  }) => Promise<{ assets: DatabaseRow[], total: number }>
  updateMediaAsset: (assetId: string, updates: {
    alt?: string | null
    tags?: string[]
    focal_point?: { x: number, y: number } | null
    variants?: Record<string, unknown>
    blurhash?: string | null
  }) => Promise<DatabaseRow>
  deleteMediaAsset: (assetId: string) => Promise<DatabaseRow | null>

  // ═══════════════════════════════════════════════════
  // MEDIA USAGE
  // ═══════════════════════════════════════════════════

  trackMediaUsage: (usage: MediaUsageInput) => Promise<void>
  removeMediaUsage: (usage: Omit<MediaUsageInput, 'project_id'>) => Promise<void>
  getMediaUsage: (assetId: string) => Promise<DatabaseRow[]>

  // ═══════════════════════════════════════════════════
  // FORM SUBMISSIONS
  // ═══════════════════════════════════════════════════

  createFormSubmission: (submission: FormSubmissionInput) => Promise<DatabaseRow>
  listFormSubmissions: (workspaceId: string, projectId: string, modelId: string, options?: PaginationOptions & {
    status?: string
    sort?: 'newest' | 'oldest'
  }) => Promise<{ submissions: DatabaseRow[], total: number }>
  getFormSubmission: (submissionId: string) => Promise<DatabaseRow | null>
  updateFormSubmissionStatus: (submissionId: string, status: 'approved' | 'rejected' | 'spam', approvedBy?: string, entryId?: string) => Promise<DatabaseRow>
  deleteFormSubmission: (submissionId: string) => Promise<void>
  bulkUpdateSubmissions: (submissionIds: string[], status: 'approved' | 'rejected' | 'spam', approvedBy?: string, scope?: {
    workspaceId?: string
    projectId?: string
    modelId?: string
  }) => Promise<number>
  countMonthlySubmissions: (workspaceId: string) => Promise<number>

  /** Atomic: check monthly limit + insert submission. Prevents race conditions. */
  createFormSubmissionIfAllowed: (
    workspaceId: string,
    monthlyLimit: number,
    submission: FormSubmissionInput,
  ) => Promise<{ allowed: boolean, currentCount: number, submission?: DatabaseRow }>

  // ═══════════════════════════════════════════════════
  // WEBHOOKS
  // ═══════════════════════════════════════════════════

  countProjectWebhooks: (projectId: string, workspaceId: string) => Promise<number>
  createWebhook: (input: {
    workspaceId: string
    projectId: string
    name: string
    url: string
    events: string[]
    secret: string
  }) => Promise<DatabaseRow>
  listProjectWebhooks: (projectId: string, workspaceId: string) => Promise<DatabaseRow[]>
  getWebhook: (webhookId: string, options?: { projectId?: string, workspaceId?: string }) => Promise<DatabaseRow | null>
  updateWebhook: (webhookId: string, projectId: string, workspaceId: string, updates: Record<string, unknown>) => Promise<DatabaseRow>
  deleteWebhook: (webhookId: string, projectId: string, workspaceId: string) => Promise<void>
  listActiveProjectWebhooks: (workspaceId: string, projectId: string) => Promise<DatabaseRow[]>

  // ═══════════════════════════════════════════════════
  // WEBHOOK DELIVERIES
  // ═══════════════════════════════════════════════════

  createWebhookDelivery: (input: {
    webhookId: string
    event: string
    payload: Record<string, unknown>
  }) => Promise<DatabaseRow>
  listWebhookDeliveries: (webhookId: string, options?: PaginationOptions) => Promise<{ deliveries: DatabaseRow[], total: number }>
  updateWebhookDelivery: (deliveryId: string, updates: Record<string, unknown>) => Promise<void>
  listPendingWebhookRetries: (limit?: number) => Promise<DatabaseRow[]>
  deleteWebhookDeliveries: (webhookId: string) => Promise<void>

  // ═══════════════════════════════════════════════════
  // CDN API KEYS
  // ═══════════════════════════════════════════════════

  validateCDNKeyHash: (keyHash: string) => Promise<DatabaseRow | null>
  updateCDNKeyLastUsed: (keyId: string) => Promise<void>
  countActiveCDNKeys: (projectId: string) => Promise<number>
  createCDNKey: (input: {
    projectId: string
    workspaceId: string
    keyHash: string
    keyPrefix: string
    name: string
  }) => Promise<DatabaseRow>
  createCDNKeyIfAllowed: (input: {
    projectId: string
    workspaceId: string
    keyHash: string
    keyPrefix: string
    name: string
    limit: number
  }) => Promise<{ allowed: boolean, currentCount: number, key?: DatabaseRow }>
  getCDNKey: (keyId: string) => Promise<DatabaseRow | null>
  listCDNKeys: (accessToken: string, projectId: string, workspaceId: string) => Promise<DatabaseRow[]>
  revokeCDNKey: (keyId: string, projectId: string) => Promise<void>

  // ═══════════════════════════════════════════════════
  // CDN BUILDS
  // ═══════════════════════════════════════════════════

  createCDNBuild: (input: {
    projectId: string
    triggerType: string
    commitSha?: string
    branch?: string
  }) => Promise<DatabaseRow>
  updateCDNBuild: (buildId: string, updates: Record<string, unknown>) => Promise<void>
  listCDNBuilds: (projectId: string, options?: PaginationOptions & { sort?: string }) => Promise<DatabaseRow[]>

  // ═══════════════════════════════════════════════════
  // CDN USAGE
  // ═══════════════════════════════════════════════════

  incrementCDNUsage: (projectId: string, apiKeyId: string, periodStart: string, requestCount: number, bandwidthBytes: number) => Promise<void>
  getMonthlyProjectCDNUsage: (projectId: string, startDate: string, endDate: string) => Promise<{ requestCount: number, bandwidthBytes: number }>

  // ═══════════════════════════════════════════════════
  // CONVERSATION API KEYS
  // ═══════════════════════════════════════════════════

  validateConversationKeyHash: (keyHash: string) => Promise<DatabaseRow | null>
  updateConversationKeyLastUsed: (keyId: string) => Promise<void>
  listConversationKeys: (projectId: string, workspaceId: string) => Promise<DatabaseRow[]>
  createConversationKey: (input: Record<string, unknown>) => Promise<DatabaseRow>
  updateConversationKey: (keyId: string, projectId: string, workspaceId: string, updates: Record<string, unknown>) => Promise<DatabaseRow>
  revokeConversationKey: (keyId: string, projectId: string, workspaceId: string) => Promise<void>
  countActiveConversationKeys: (projectId: string, workspaceId: string) => Promise<number>
  getConversationKeyUsage: (keyIds: string[], month: string) => Promise<DatabaseRow[]>

  // ═══════════════════════════════════════════════════
  // MCP CLOUD KEYS
  // ═══════════════════════════════════════════════════

  getMcpCloudKeyByHash: (keyHash: string) => Promise<DatabaseRow | null>
  touchMcpCloudKey: (keyId: string) => Promise<void>
  listMcpCloudKeys: (workspaceId: string, projectId?: string) => Promise<DatabaseRow[]>
  createMcpCloudKey: (input: {
    workspaceId: string
    projectId: string
    name: string
    keyHash: string
    keyPrefix: string
    allowedTools: string[]
    rateLimitPerMinute?: number
    monthlyCallLimit?: number | null
    createdBy?: string | null
  }) => Promise<DatabaseRow>
  revokeMcpCloudKey: (keyId: string, workspaceId: string) => Promise<void>
  countActiveMcpCloudKeys: (workspaceId: string, projectId?: string) => Promise<number>
  /** Atomic: check monthly call limit + bump counter. Returns `{ allowed, used }`. */
  incrementMcpCloudUsageIfAllowed: (input: {
    workspaceId: string
    keyId: string
    month: string
    limit: number | null
  }) => Promise<{ allowed: boolean, used: number }>
  /** Sum MCP Cloud call count across all keys in workspace for a month. */
  getWorkspaceMonthlyMcpCloudUsage: (workspaceId: string, month: string) => Promise<number>

  // ═══════════════════════════════════════════════════
  // TRIAL REMINDERS
  // ═══════════════════════════════════════════════════

  /**
   * List trialing workspaces whose `trial_ends_at` falls in [from, to] and
   * whose `trial_reminder_stage` is strictly below `requiredStage`. The cron
   * uses this to pick workspaces that still need the next reminder in the
   * sequence (T-3 → T-1 → T-0).
   */
  listWorkspacesPendingTrialReminder: (args: {
    from: string
    to: string
    requiredStage: number
  }) => Promise<DatabaseRow[]>

  /** Set `trial_reminder_stage` for a workspace. Cron calls this after send. */
  setTrialReminderStage: (workspaceId: string, stage: number) => Promise<void>

  // ═══════════════════════════════════════════════════
  // USAGE AGGREGATION (billing dashboard)
  // ═══════════════════════════════════════════════════

  /** Sum AI message count (source=studio) across all users in workspace for a month. */
  getWorkspaceMonthlyAIUsage: (workspaceId: string, month: string) => Promise<number>
  /** Sum API message count (source=api) across all API keys in workspace for a month. */
  getWorkspaceMonthlyAPIUsage: (workspaceId: string, month: string) => Promise<number>
  /** Sum CDN bandwidth bytes across all projects in workspace for a month. */
  getWorkspaceMonthlyCDNBandwidth: (workspaceId: string, month: string) => Promise<number>

  // ═══════════════════════════════════════════════════
  // OVERAGE BILLING LOG
  // ═══════════════════════════════════════════════════

  getOverageBillingLog: (workspaceId: string, billingPeriod: string) => Promise<DatabaseRow[]>
  createOverageBillingEntry: (entry: {
    workspaceId: string
    billingPeriod: string
    category: string
    unitsBilled: number
    unitPrice: number
    totalAmount: number
    stripeInvoiceItemId?: string
  }) => Promise<DatabaseRow>
  hasOverageBeenBilled: (workspaceId: string, billingPeriod: string, category: string) => Promise<boolean>

  // ═══════════════════════════════════════════════════
  // AUDIT LOGS
  // ═══════════════════════════════════════════════════

  createAuditLog: (entry: {
    workspaceId?: string | null
    actorId?: string | null
    action: string
    tableName: string
    recordId: string
    recordSnapshot?: Record<string, unknown> | null
    sourceIp?: string | null
    userAgent?: string | null
    origin?: 'app' | 'cascade'
  }) => Promise<void>

  listAuditLogs: (workspaceId: string, options?: {
    page?: number
    limit?: number
    action?: string
    sort?: 'newest' | 'oldest'
  }) => Promise<{ data: DatabaseRow[], total: number }>
}

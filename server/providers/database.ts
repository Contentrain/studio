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

/**
 * Shape of one row in the `messages` table for write operations.
 *
 * `content_blocks` is the structured Anthropic-protocol payload
 * (text + tool_use + tool_result discriminated array) and takes
 * precedence over the legacy `content` + `toolCalls` pair on read.
 *
 * `turnId` groups all rows produced by a single chat POST — seed
 * user row, every assistant iteration, every tool_result iteration.
 * `turnSequence` orders rows within the turn deterministically;
 * `iteration` is the engine's per-turn iteration counter (NULL for
 * the seed user row).
 *
 * `internal=true` rows are part of the protocol-replay trace but
 * MUST NOT appear in the user-facing transcript — RLS enforces this
 * for client-side queries; the resume path uses the service role to
 * read across the boundary.
 */
export interface MessageInsertInput {
  conversationId: string
  role: 'user' | 'assistant'
  content: string
  contentBlocks?: unknown[] | null
  /** Legacy column kept for backward compat with old single-row writes. */
  toolCalls?: unknown[] | null
  turnId: string
  turnSequence: number
  iteration?: number | null
  internal: boolean
  tokenCountInput?: number
  tokenCountOutput?: number
  cacheCreationInputTokens?: number
  cacheReadInputTokens?: number
  model?: string
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
  // OAUTH PROVIDER TOKENS
  // ═══════════════════════════════════════════════════

  /**
   * Persist an encrypted OAuth provider token (currently only GitHub).
   * Tokens are encrypted with AES-256-GCM (NUXT_SESSION_SECRET-derived
   * key) and stored in `oauth_provider_tokens`. Upsert on (user_id, provider).
   */
  upsertOAuthProviderToken: (input: {
    userId: string
    provider: 'github'
    accessToken: string
    refreshToken: string | null
    expiresAt: number | null
    refreshTokenExpiresAt: number | null
  }) => Promise<void>

  /**
   * Retrieve a stored provider token. Returns null when missing OR when
   * decryption fails (secret rotation without _PREVIOUS, etc.) — the
   * caller treats both as "no usable token" and drives re-auth.
   */
  getOAuthProviderToken: (userId: string, provider: 'github') => Promise<{
    accessToken: string
    refreshToken: string | null
    expiresAt: number | null
    refreshTokenExpiresAt: number | null
  } | null>

  /** Remove a stored provider token (e.g. after a refresh-token failure). */
  deleteOAuthProviderToken: (userId: string, provider: 'github') => Promise<void>

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
  /**
   * Mark a workspace's free trial as consumed (idempotent — only sets the
   * timestamp the first time). Gates re-trial at checkout so a workspace
   * gets at most one trial across its lifetime.
   */
  markWorkspaceTrialConsumed: (workspaceId: string) => Promise<void>
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
  /**
   * Update `workspaces.github_installation_status` ('active'|'suspended'|'unbound').
   * Lookup target is either a single workspace (by id) or every workspace bound
   * to the given installation_id (for webhook fan-out). Multi-row update is
   * intentional: the schema does not enforce UNIQUE on github_installation_id.
   */
  updateWorkspaceInstallationStatus: (
    target: { workspaceId: string } | { installationId: number },
    status: 'active' | 'suspended' | 'unbound',
  ) => Promise<void>
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
  /**
   * Flip a project's repo-level access state. Scoped to projects owned
   * by a workspace bound to `installationId` (joined via workspaces),
   * because the same `repo_full_name` could in theory exist under
   * multiple installations and we only want to touch the ones the
   * webhook event applies to.
   */
  updateProjectAccessStatus: (
    target: { installationId: number, repoFullName: string },
    status: 'accessible' | 'inaccessible' | 'deleted',
  ) => Promise<void>
  /**
   * Rename a project's `repo_full_name` when the underlying GitHub repo
   * is renamed. Scoped by installation_id so a webhook for one tenant
   * doesn't accidentally rename a same-named project in another.
   */
  renameProjectRepo: (
    target: { installationId: number, oldFullName: string },
    newFullName: string,
  ) => Promise<void>
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
  /**
   * Create a Conversation API-owned chat thread. The API key acts as
   * the actor in place of a workspace member; `conversations.user_id`
   * stays NULL and `api_key_id` carries the owner reference. Enforced
   * by `conversations_actor_xor` — exactly one of user_id / api_key_id
   * is non-null per row.
   */
  createApiConversation: (projectId: string, apiKeyId: string, title: string) => Promise<string | null>
  /**
   * Ownership check before continuing a conversation. Pass either a
   * `userId` (Studio chat) or an `apiKeyId` (Conversation API) — never
   * both. The XOR is mirrored from the DB-level CHECK on `conversations`.
   */
  getConversation: (
    conversationId: string,
    projectId: string,
    filters?: { userId: string } | { apiKeyId: string },
  ) => Promise<DatabaseRow | null>
  listConversations: (accessToken: string, projectId: string, userId: string) => Promise<DatabaseRow[]>
  deleteConversation: (accessToken: string, conversationId: string, userId: string, projectId: string) => Promise<void>
  updateConversationTimestamp: (conversationId: string) => Promise<void>

  // ═══════════════════════════════════════════════════
  // MESSAGES
  // ═══════════════════════════════════════════════════

  /**
   * Load conversation messages for the engine's resume path or the
   * public transcript route.
   *
   * `options.includeInternal` defaults to `false` — the public route
   * MUST NOT pass `true`. Only the chat / Conversation API resume
   * paths set it to load the full Anthropic-protocol shape
   * (intermediate assistant turns + tool_result blocks) needed to
   * reconstruct prior multi-iteration loops.
   */
  loadConversationMessages: (
    conversationId: string,
    limit?: number,
    fields?: string,
    options?: { includeInternal?: boolean },
  ) => Promise<DatabaseRow[]>

  /**
   * Insert a single message row. Convenience wrapper around the batch
   * path used in places that only persist one row (e.g. an event
   * stream side-effect). For the chat persistence path use
   * `insertMessages` so the entire turn lands atomically in one
   * round-trip.
   */
  insertMessage: (input: MessageInsertInput) => Promise<void>

  /**
   * Atomic batch insert for the full assistant/tool_result trace a
   * single chat POST produces. All rows in one batch share the same
   * `turnId` so resume reads can group them deterministically; the
   * caller assigns `turnSequence` in protocol order so two rows that
   * land at the same `created_at` still resolve consistently.
   */
  insertMessages: (rows: MessageInsertInput[]) => Promise<void>

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

  /**
   * Update token counts on an existing `agent_usage` row after the
   * chat completes. Cache token fields are required (callers pass 0
   * when the provider didn't report cache usage) so the call shape
   * stays stable and the underlying `_v2` RPC always receives all
   * four values.
   */
  updateAgentUsageTokens: (input: {
    workspaceId: string
    userId: string
    month: string
    source: string
    inputTokens: number
    outputTokens: number
    cacheCreationInputTokens: number
    cacheReadInputTokens: number
  }) => Promise<void>

  /**
   * Revert a previously-reserved message slot. Called from chat error
   * paths when the AI call never produced a billable event (text or
   * tool_use). Clamped at zero by the underlying RPC so concurrent
   * reverts can't push `message_count` negative.
   */
  decrementAgentUsage: (input: {
    workspaceId: string
    userId: string
    month: string
    source: string
  }) => Promise<void>

  // ═══════════════════════════════════════════════════
  // API MESSAGE USAGE (Conversation API)
  // ═══════════════════════════════════════════════════

  /**
   * Atomic: enforce BOTH per-key and per-workspace monthly caps in
   * one RPC and reserve a message slot. Reason discriminator lets the
   * caller surface the right 429 message ("your key is over" vs "the
   * workspace plan is over").
   *
   * Pass `SOFT_CAP_MAX` (from `getEffectiveLimit`) for either limit
   * when overage is enabled or the plan grants Infinity.
   */
  incrementAPIUsageIfAllowed: (input: {
    workspaceId: string
    apiKeyId: string
    month: string
    keyLimit: number
    workspaceLimit: number
  }) => Promise<{
    allowed: boolean
    reason: 'ok' | 'key_limit' | 'workspace_limit'
    current: number
  }>

  /**
   * Increment token counters on the `api_message_usage` row after the
   * AI call settles. Cache token fields are required for the same
   * stability reason as `updateAgentUsageTokens`.
   */
  updateAPIUsageTokens: (input: {
    workspaceId: string
    apiKeyId: string
    month: string
    inputTokens: number
    outputTokens: number
    cacheCreationInputTokens: number
    cacheReadInputTokens: number
  }) => Promise<void>

  /**
   * Revert a previously-reserved API message slot. Symmetric with
   * `decrementAgentUsage` for the Conversation API path.
   */
  decrementAPIUsage: (input: {
    workspaceId: string
    apiKeyId: string
    month: string
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
    scopes?: string[]
  }) => Promise<DatabaseRow>
  createCDNKeyIfAllowed: (input: {
    projectId: string
    workspaceId: string
    keyHash: string
    keyPrefix: string
    name: string
    limit: number
    scopes?: string[]
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
  /** Accumulate keyless (public-media) CDN usage into the project-level NULL-key bucket. */
  incrementPublicCDNUsage: (projectId: string, periodStart: string, requestCount: number, bandwidthBytes: number) => Promise<void>
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
  /** Per-key MCP Cloud call counts for a month. Rows: `{ mcp_key_id, call_count }`. */
  getMcpCloudKeyUsage: (keyIds: string[], month: string) => Promise<DatabaseRow[]>

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
  // PAYMENT ACCOUNTS (per-provider subscription state)
  // ═══════════════════════════════════════════════════

  /** Return the single active payment account for a workspace, if any. */
  getActivePaymentAccount: (workspaceId: string) => Promise<DatabaseRow | null>

  /**
   * Upsert a payment account keyed on (workspace_id, provider, customer_id).
   *
   * When a row is created or promoted to active, any previously active
   * account on the same workspace is archived (`is_active=false`,
   * `archived_at=now()`). This preserves history while enforcing the
   * one-active-per-workspace invariant.
   */
  upsertPaymentAccount: (input: {
    workspaceId: string
    provider: string
    customerId: string
    subscriptionId?: string | null
    subscriptionStatus?: string | null
    currentPeriodEnd?: string | null
    trialEndsAt?: string | null
    cancelAtPeriodEnd?: boolean
    gracePeriodEndsAt?: string | null
    plan?: string | null
    pluginMetadata?: Record<string, unknown>
    isActive?: boolean
  }) => Promise<DatabaseRow>

  /** Archive the active payment account for a workspace (no-op if none). */
  archiveActivePaymentAccount: (workspaceId: string) => Promise<void>

  // ═══════════════════════════════════════════════════
  // USAGE EVENTS OUTBOX (provider-agnostic meter pipeline)
  // ═══════════════════════════════════════════════════

  /**
   * Enqueue a usage event for later ingestion by the active PaymentProvider.
   * Duplicate idempotency keys are silently ignored (constraint-safe).
   */
  enqueueUsageEvent: (input: {
    workspaceId: string
    meterName: string
    value: number
    idempotencyKey: string
    occurredAt?: string
    metadata?: Record<string, unknown>
  }) => Promise<void>

  /** List pending (not-yet-ingested) usage events, oldest first. */
  listPendingUsageEvents: (limit: number) => Promise<DatabaseRow[]>

  /** Mark an outbox row ingested (error=null) or record a failed attempt. */
  markUsageEventIngested: (id: string, error?: string | null) => Promise<void>

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

  // Purges audit logs older than retentionDays (default 90). Returns the
  // purged row count; implementations log-and-return-0 on failure — the
  // audit path must never break a request or a maintenance cycle.
  cleanupAuditLogs: (retentionDays?: number) => Promise<number>
}

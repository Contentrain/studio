/**
 * Kysely table map for the plain-Postgres DatabaseProvider.
 *
 * Column types mirror what PostgREST hands the Supabase implementation so
 * both providers return identical value shapes to callers:
 *   - timestamptz → ISO string (pg type parser in client.ts)
 *   - int8        → number    (pg type parser in client.ts)
 *   - jsonb       → unknown
 *
 * The map is extended table-by-table as DatabaseProvider modules are ported;
 * source of truth is supabase/migrations (001_baseline.sql + follow-ups).
 */
import type { Generated } from 'kysely'

export interface ProfilesTable {
  id: string
  display_name: string | null
  email: string | null
  avatar_url: string | null
  created_at: Generated<string | null>
  theme: Generated<string>
}

export interface OAuthProviderTokensTable {
  user_id: string
  provider: string
  encrypted_access_token: string
  encrypted_refresh_token: string | null
  access_token_expires_at: string | null
  refresh_token_expires_at: string | null
  created_at: Generated<string>
  updated_at: Generated<string>
}

export interface AuditLogsTable {
  id: Generated<string>
  workspace_id: string | null
  actor_id: string | null
  action: string
  table_name: string
  record_id: string
  record_snapshot: unknown | null
  source_ip: string | null
  user_agent: string | null
  origin: Generated<string>
  created_at: Generated<string>
}

export interface PaymentAccountsTable {
  id: Generated<string>
  workspace_id: string
  provider: string
  customer_id: string
  subscription_id: string | null
  subscription_status: string | null
  current_period_end: string | null
  trial_ends_at: string | null
  cancel_at_period_end: Generated<boolean>
  grace_period_ends_at: string | null
  plan: string | null
  plugin_metadata: Generated<unknown>
  is_active: Generated<boolean>
  archived_at: string | null
  created_at: Generated<string>
  updated_at: Generated<string>
}

export interface WorkspacesTable {
  id: Generated<string>
  name: string
  slug: string
  type: Generated<string>
  owner_id: string
  logo_url: string | null
  github_installation_id: number | null
  github_installation_status: Generated<string>
  plan: Generated<string>
  created_at: Generated<string | null>
  media_storage_bytes: Generated<number>
  trial_ends_at: string | null
  trial_consumed_at: string | null
  stripe_customer_id: string | null
  stripe_subscription_id: string | null
  subscription_status: string | null
  subscription_current_period_end: string | null
  subscription_cancel_at_period_end: boolean | null
  grace_period_ends_at: string | null
  overage_settings: Generated<unknown>
  trial_reminder_stage: Generated<number>
}

export interface WorkspaceMembersTable {
  id: Generated<string>
  workspace_id: string
  user_id: string | null
  role: string
  invited_email: string | null
  invited_at: Generated<string | null>
  accepted_at: string | null
}

export interface AiKeysTable {
  id: Generated<string>
  workspace_id: string
  user_id: string
  provider: string
  encrypted_key: string
  key_hint: string | null
  created_at: Generated<string | null>
}

export interface ProjectsTable {
  id: Generated<string>
  workspace_id: string
  repo_full_name: string
  default_branch: Generated<string>
  content_root: Generated<string>
  detected_stack: string | null
  status: Generated<string>
  access_status: Generated<string>
  created_at: Generated<string | null>
  content_updated_at: string | null
  cdn_enabled: Generated<boolean>
  cdn_branch: string | null
  migration_handoff: unknown | null
  migration_handoff_synced_at: string | null
}

export interface ProjectMembersTable {
  id: Generated<string>
  project_id: string
  user_id: string | null
  role: string
  specific_models: Generated<boolean>
  allowed_models: Generated<string[]>
  invited_email: string | null
  invited_at: Generated<string | null>
  accepted_at: string | null
}

export interface WebhooksTable {
  id: Generated<string>
  project_id: string
  workspace_id: string
  url: string
  events: string[]
  secret: string
  active: Generated<boolean>
  name: Generated<string>
  created_at: Generated<string>
  updated_at: Generated<string>
}

export interface MediaAssetsTable {
  id: Generated<string>
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
  focal_point: unknown | null
  duration_seconds: string | null
  alt: string | null
  tags: Generated<string[]>
  original_path: string
  variants: Generated<unknown>
  uploaded_by: string | null // nullable since 015 (detached on uploader account deletion)
  source: Generated<string>
  created_at: Generated<string>
  updated_at: Generated<string>
}

export interface AgentUsageTable {
  id: Generated<string>
  workspace_id: string
  user_id: string
  month: string
  message_count: Generated<number>
  input_tokens: Generated<number>
  output_tokens: Generated<number>
  source: Generated<string>
  updated_at: Generated<string | null>
  api_key_id: string | null
}

export interface ApiMessageUsageTable {
  id: Generated<string>
  workspace_id: string
  api_key_id: string
  month: string
  message_count: Generated<number>
  input_tokens: Generated<number>
  output_tokens: Generated<number>
  updated_at: Generated<string>
}

export interface CdnUsageTable {
  id: Generated<string>
  project_id: string
  api_key_id: string | null
  period_start: string
  request_count: Generated<number>
  bandwidth_bytes: Generated<number>
}

export interface ConversationsTable {
  id: Generated<string>
  project_id: string
  user_id: string | null
  api_key_id: string | null
  title: string | null
  created_at: Generated<string | null>
  updated_at: Generated<string | null>
}

export interface MessagesTable {
  id: Generated<string>
  conversation_id: string
  role: string
  content: string
  tool_calls: unknown | null
  token_count_input: Generated<number>
  token_count_output: Generated<number>
  cache_creation_input_tokens: Generated<number>
  cache_read_input_tokens: Generated<number>
  model: string | null
  created_at: Generated<string | null>
  content_blocks: unknown | null
  turn_id: Generated<string>
  turn_sequence: Generated<number>
  iteration: number | null
  internal: Generated<boolean>
}

export interface CdnApiKeysTable {
  id: Generated<string>
  project_id: string
  workspace_id: string
  key_hash: string
  key_prefix: string
  name: string
  environment: Generated<string>
  rate_limit_per_hour: Generated<number>
  allowed_origins: string[] | null
  scopes: Generated<string[]>
  last_used_at: string | null
  expires_at: string | null
  created_at: Generated<string>
  revoked_at: string | null
}

export interface CdnBuildsTable {
  id: Generated<string>
  project_id: string
  trigger_type: Generated<string>
  commit_sha: string
  branch: string
  status: Generated<string>
  content_hash: string | null
  file_count: number | null
  total_size_bytes: number | null
  changed_models: string[] | null
  build_duration_ms: number | null
  error_message: string | null
  started_at: Generated<string>
  completed_at: string | null
}

export interface McpCloudKeysTable {
  id: Generated<string>
  project_id: string
  workspace_id: string
  key_hash: string
  key_prefix: string
  name: string
  allowed_tools: Generated<string[]>
  media_enabled: Generated<boolean>
  rate_limit_per_minute: Generated<number>
  monthly_call_limit: number | null
  last_used_at: string | null
  created_at: Generated<string>
  created_by: string | null
  revoked_at: string | null
}

export interface McpCloudUsageTable {
  workspace_id: string
  month: string
  mcp_key_id: string
  call_count: Generated<number>
  last_call_at: Generated<string>
}

export interface McpOauthUsageTable {
  workspace_id: string
  month: string
  grant_id: string
  call_count: Generated<number>
  last_call_at: Generated<string>
}

export interface MediaUsageTable {
  id: Generated<string>
  asset_id: string
  project_id: string
  model_id: string
  entry_id: string
  field_id: string
  locale: string
  created_at: Generated<string>
}

export interface FormSubmissionsTable {
  id: Generated<string>
  project_id: string
  workspace_id: string
  model_id: string
  data: unknown
  status: Generated<string>
  source_ip: string | null
  user_agent: string | null
  referrer: string | null
  locale: Generated<string | null>
  approved_at: string | null
  approved_by: string | null
  entry_id: string | null
  created_at: Generated<string>
}

export interface CommentsTable {
  id: Generated<string>
  project_id: string
  workspace_id: string
  model_id: string
  entry_id: string
  locale: Generated<string>
  parent_id: string | null
  /** Filled by the BEFORE INSERT trigger — never supplied by the app. */
  root_id: Generated<string>
  depth: Generated<number>
  author_name: string
  author_email: string | null
  author_url: string | null
  author_user_id: string | null
  body: string
  status: Generated<string>
  type: Generated<string>
  source: Generated<string>
  source_id: string | null
  source_parent_id: string | null
  source_ip: string | null
  user_agent: string | null
  referrer: string | null
  moderated_at: string | null
  moderated_by: string | null
  created_at: Generated<string>
  updated_at: Generated<string>
}

export interface CommentThreadsTable {
  project_id: string
  workspace_id: string
  model_id: string
  entry_id: string
  locale: Generated<string>
  closed_at: string | null
  closed_by: string | null
  created_at: Generated<string>
  updated_at: Generated<string>
}

export interface ConversationApiKeysTable {
  id: Generated<string>
  project_id: string
  workspace_id: string
  key_hash: string
  key_prefix: string
  name: string
  role: Generated<string>
  specific_models: Generated<boolean>
  allowed_models: Generated<string[] | null>
  allowed_tools: Generated<string[] | null>
  allowed_locales: Generated<string[] | null>
  custom_instructions: string | null
  ai_model: Generated<string>
  rate_limit_per_minute: Generated<number>
  monthly_message_limit: Generated<number>
  last_used_at: string | null
  created_at: Generated<string>
  revoked_at: string | null
}

export interface WebhookDeliveriesTable {
  id: Generated<string>
  webhook_id: string
  event: string
  payload: unknown
  status: Generated<string>
  response_code: number | null
  response_body: string | null
  retry_count: Generated<number>
  next_retry_at: string | null
  delivered_at: string | null
  created_at: Generated<string>
}

export interface UsageEventsOutboxTable {
  id: Generated<string>
  workspace_id: string
  meter_name: string
  value: number | string
  occurred_at: Generated<string>
  idempotency_key: string
  metadata: Generated<unknown>
  ingested_at: string | null
  attempt_count: Generated<number>
  last_error: string | null
}

// ─── auth schema (postgres/migrations/000_auth_shim.sql) ───
// Owned by the managed AuthProvider; present only on the postgres pair.

export interface AuthUsersTable {
  id: Generated<string>
  email: string
  raw_user_meta_data: Generated<unknown>
  provider: string | null
  provider_account_id: string | null
  email_verified_at: string | null
  last_sign_in_at: string | null
  created_at: Generated<string>
  updated_at: Generated<string>
}

export interface AuthRefreshTokensTable {
  id: Generated<string>
  user_id: string
  token_hash: string
  family_id: string
  created_at: Generated<string>
  expires_at: string
  rotated_at: string | null
  revoked_at: string | null
}

export interface AuthOneTimeTokensTable {
  id: Generated<string>
  email: string
  user_id: string | null
  token_hash: string
  token_type: string
  payload: Generated<unknown>
  created_at: Generated<string>
  expires_at: string
  consumed_at: string | null
}

// ─── OAuth AS tables (postgres/migrations/016_oauth_server.sql) ───
// Owned by server/utils/oauth-server/store.ts; present only on the postgres pair.

export interface AuthOauthClientsTable {
  client_id: string
  kind: 'cimd' | 'dcr'
  client_name: string | null
  client_uri: string | null
  logo_uri: string | null
  redirect_uris: Generated<unknown>
  token_endpoint_auth_method: Generated<string>
  metadata: Generated<unknown>
  metadata_fetched_at: string | null
  created_at: Generated<string>
  last_used_at: string | null
}

export interface AuthOauthGrantsTable {
  id: Generated<string>
  user_id: string
  client_id: string
  workspace_id: string
  project_id: string
  scope: string
  created_at: Generated<string>
  last_used_at: string | null
  revoked_at: string | null
}

export interface AuthOauthAuthorizationCodesTable {
  id: Generated<string>
  code_hash: string
  client_id: string
  user_id: string
  workspace_id: string
  project_id: string
  redirect_uri: string
  scope: string
  code_challenge: string
  code_challenge_method: Generated<string>
  resource: string | null
  created_at: Generated<string>
  expires_at: string
  consumed_at: string | null
}

export interface AuthOauthAccessTokensTable {
  id: Generated<string>
  token_hash: string
  grant_id: string
  created_at: Generated<string>
  expires_at: string
}

export interface AuthOauthRefreshTokensTable {
  id: Generated<string>
  grant_id: string
  token_hash: string
  family_id: string
  created_at: Generated<string>
  expires_at: string
  rotated_at: string | null
  revoked_at: string | null
}

export interface StudioDatabase {
  'auth.users': AuthUsersTable
  'auth.refresh_tokens': AuthRefreshTokensTable
  'auth.one_time_tokens': AuthOneTimeTokensTable
  'auth.oauth_clients': AuthOauthClientsTable
  'auth.oauth_grants': AuthOauthGrantsTable
  'auth.oauth_authorization_codes': AuthOauthAuthorizationCodesTable
  'auth.oauth_access_tokens': AuthOauthAccessTokensTable
  'auth.oauth_refresh_tokens': AuthOauthRefreshTokensTable
  'profiles': ProfilesTable
  'oauth_provider_tokens': OAuthProviderTokensTable
  'audit_logs': AuditLogsTable
  'payment_accounts': PaymentAccountsTable
  'workspaces': WorkspacesTable
  'workspace_members': WorkspaceMembersTable
  'ai_keys': AiKeysTable
  'projects': ProjectsTable
  'project_members': ProjectMembersTable
  'webhooks': WebhooksTable
  'media_assets': MediaAssetsTable
  'agent_usage': AgentUsageTable
  'api_message_usage': ApiMessageUsageTable
  'cdn_usage': CdnUsageTable
  'conversations': ConversationsTable
  'messages': MessagesTable
  'cdn_api_keys': CdnApiKeysTable
  'cdn_builds': CdnBuildsTable
  'mcp_cloud_keys': McpCloudKeysTable
  'mcp_cloud_usage': McpCloudUsageTable
  'mcp_oauth_usage': McpOauthUsageTable
  'media_usage': MediaUsageTable
  'form_submissions': FormSubmissionsTable
  'comments': CommentsTable
  'comment_threads': CommentThreadsTable
  'conversation_api_keys': ConversationApiKeysTable
  'webhook_deliveries': WebhookDeliveriesTable
  'usage_events_outbox': UsageEventsOutboxTable
}

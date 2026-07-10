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

export interface StudioDatabase {
  profiles: ProfilesTable
  oauth_provider_tokens: OAuthProviderTokensTable
  audit_logs: AuditLogsTable
  payment_accounts: PaymentAccountsTable
  workspaces: WorkspacesTable
  workspace_members: WorkspaceMembersTable
  ai_keys: AiKeysTable
  projects: ProjectsTable
  project_members: ProjectMembersTable
  webhooks: WebhooksTable
}

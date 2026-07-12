-- OAuth 2.1 Authorization Server tables — managed (Supabase-free) pair only.
--
-- Backs the remote MCP surface (/api/mcp/remote): Studio itself acts as the
-- authorization server for MCP clients (Claude, ChatGPT, Codex). Lives in
-- postgres/migrations/ so the Supabase CLI never sees it — the OAuth AS only
-- boots when NUXT_AUTH_PROVIDER=managed, and these tables join auth.users,
-- which GoTrue owns on the Supabase pair.
--
-- Access pattern: service-role only, via server/utils/oauth-server/store.ts
-- (the managed-auth precedent — no DatabaseProvider methods, no RLS
-- policies needed; 000_auth_shim.sql already grants service_role ALL on
-- every auth-schema table).

-- OAuth clients. Two registration mechanisms, one table:
--   - CIMD (client_id = the HTTPS metadata-document URL; the row caches the
--     fetched document so /oauth/authorize doesn't refetch on every dance)
--   - DCR  (client_id = 'dcr_' || hex; Claude falls back to DCR when CIMD is
--     unavailable and registers a NEW client per fresh connection, so DCR
--     rows are garbage-collected once orphaned — see cleanupExpired()).
-- Public clients only: PKCE carries the proof, no client_secret column.
CREATE TABLE auth.oauth_clients (
  client_id text PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('cimd', 'dcr')),
  client_name text,
  client_uri text,
  logo_uri text,
  redirect_uris jsonb NOT NULL DEFAULT '[]'::jsonb,
  token_endpoint_auth_method text NOT NULL DEFAULT 'none',
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  metadata_fetched_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz
);

-- A grant is the consent record: one (user, client, workspace, project)
-- tuple with the approved scope. Tokens hang off it; revoking the grant
-- kills every token derived from it. Switching projects means a fresh
-- authorize dance, which upserts onto the active tuple.
CREATE TABLE auth.oauth_grants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  client_id text NOT NULL REFERENCES auth.oauth_clients (client_id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES public.workspaces (id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES public.projects (id) ON DELETE CASCADE,
  scope text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);

CREATE UNIQUE INDEX oauth_grants_active_tuple_key
  ON auth.oauth_grants (user_id, client_id, workspace_id, project_id)
  WHERE revoked_at IS NULL;
CREATE INDEX oauth_grants_workspace_idx
  ON auth.oauth_grants (workspace_id)
  WHERE revoked_at IS NULL;
CREATE INDEX oauth_grants_user_idx
  ON auth.oauth_grants (user_id)
  WHERE revoked_at IS NULL;

-- Authorization codes: single-use (atomic consume à la auth.one_time_tokens),
-- 120s TTL. Carries the pending grant context plus the PKCE challenge and
-- the RFC 8707 resource the client asked for.
CREATE TABLE auth.oauth_authorization_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code_hash text NOT NULL UNIQUE,
  client_id text NOT NULL REFERENCES auth.oauth_clients (client_id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL,
  project_id uuid NOT NULL,
  redirect_uri text NOT NULL,
  scope text NOT NULL,
  code_challenge text NOT NULL,
  code_challenge_method text NOT NULL DEFAULT 'S256',
  resource text,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz
);

-- Opaque access tokens (crn_oat_*): SHA-256 hash rows, 1h TTL. MCP clients
-- treat access tokens as opaque; the resource route resolves hash → grant on
-- every request, which doubles as instant revocation.
CREATE TABLE auth.oauth_access_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash text NOT NULL UNIQUE,
  grant_id uuid NOT NULL REFERENCES auth.oauth_grants (id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);

CREATE INDEX oauth_access_tokens_grant_idx
  ON auth.oauth_access_tokens (grant_id);

-- Refresh tokens (crn_ort_*): mirror of auth.refresh_tokens rotation
-- semantics (family + rotated_at + grace-window replay revocation), bound to
-- a grant instead of a bare user. 30-day TTL; issued only when the grant's
-- scope includes offline_access.
CREATE TABLE auth.oauth_refresh_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  grant_id uuid NOT NULL REFERENCES auth.oauth_grants (id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  family_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  rotated_at timestamptz,
  revoked_at timestamptz
);

CREATE INDEX oauth_refresh_tokens_grant_idx
  ON auth.oauth_refresh_tokens (grant_id);
CREATE INDEX oauth_refresh_tokens_family_idx
  ON auth.oauth_refresh_tokens (family_id);

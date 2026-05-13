-- GitHub App installation lifecycle: persisted user OAuth tokens + installation health.
--
-- Adds two pieces of state needed for the full installation lifecycle the
-- product now supports (connect-existing flow, suspend/unsuspend tracking,
-- ownership-verified attach):
--
-- 1. `oauth_provider_tokens` — encrypted per-(user, provider) token storage.
--    Required because Supabase Auth surfaces `provider_token` only on the
--    OAuth callback and does not persist it server-side; without storage we
--    cannot call `GET /user/installations` after the initial sign-in.
--    Tokens are encrypted at rest with AES-256-GCM via the existing
--    `server/utils/encryption.ts` helper (versioned base64 ciphertext,
--    SHA-256 key derived from NUXT_SESSION_SECRET, rotation-aware).
--    Columns are `text` to match BYOA API-key storage on
--    `ai_keys.encrypted_key`; RLS keeps rows server-only.
--
-- 2. `workspaces.github_installation_status` — tracks installation health
--    independently of `github_installation_id` so we can distinguish
--    'active' / 'suspended' / 'unbound'. Webhook events
--    `installation.suspend` / `unsuspend` / `deleted` update this column
--    rather than nulling the id.

-- =========================================================================
-- oauth_provider_tokens — encrypted user-OAuth tokens per provider
-- =========================================================================

CREATE TABLE public.oauth_provider_tokens (
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  provider text NOT NULL,
  encrypted_access_token text NOT NULL,
  encrypted_refresh_token text,
  access_token_expires_at timestamp with time zone,
  refresh_token_expires_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, provider),
  CONSTRAINT oauth_provider_tokens_provider_check
    CHECK (provider IN ('github'))
);

CREATE OR REPLACE FUNCTION public.oauth_provider_tokens_set_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER oauth_provider_tokens_updated_at
  BEFORE UPDATE ON public.oauth_provider_tokens
  FOR EACH ROW
  EXECUTE FUNCTION public.oauth_provider_tokens_set_updated_at();

-- Server-only (service role). No client-facing policies — encrypted ciphertexts
-- must never leak to the browser even with a valid user JWT.
ALTER TABLE public.oauth_provider_tokens ENABLE ROW LEVEL SECURITY;

-- =========================================================================
-- workspaces.github_installation_status — installation health
-- =========================================================================

ALTER TABLE public.workspaces
  ADD COLUMN github_installation_status text NOT NULL DEFAULT 'unbound';

ALTER TABLE public.workspaces
  ADD CONSTRAINT workspaces_github_installation_status_check
    CHECK (github_installation_status IN ('active', 'suspended', 'unbound'));

-- Backfill: pre-existing workspaces with installation_id are considered
-- 'active' (webhook will correct to 'suspended' if applicable on next event).
UPDATE public.workspaces
  SET github_installation_status = 'active'
  WHERE github_installation_id IS NOT NULL;

-- Webhook handlers (installation.suspend/unsuspend/deleted) look up
-- workspaces by installation_id. Without this index the lookup is a
-- full table scan on every installation event.
CREATE INDEX IF NOT EXISTS idx_workspaces_github_installation_id
  ON public.workspaces (github_installation_id)
  WHERE github_installation_id IS NOT NULL;

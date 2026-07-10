-- Plain-Postgres auth shim — managed (Supabase-free) deployments only.
--
-- Applied by scripts/migrate-postgres.mjs BEFORE supabase/migrations/*.sql.
-- Deliberately lives OUTSIDE supabase/migrations/ so the Supabase CLI never
-- sees it: on Supabase deployments GoTrue owns the auth schema and the
-- platform provisions the roles this file creates. Same migration files,
-- two runners, one lineage.
--
-- What it provides (the contract 001_baseline.sql documents at its head):
--   1. The Supabase-standard roles (anon / authenticated / service_role) —
--      without them 002_public_grants.sql fails on plain Postgres.
--   2. The auth schema: auth.users (superset of what handle_new_user() and
--      the profiles / oauth_provider_tokens FKs need) plus the managed-auth
--      token tables (refresh_tokens, one_time_tokens).
--   3. auth.uid() reading request.jwt.claim.sub — the same GUC the RLS
--      test-suite sets today and the postgres DatabaseProvider will set
--      per transaction.

-- ─── Roles ───
-- NOLOGIN group roles; the deployment's login role is granted membership by
-- the operator (CI connects as the postgres superuser). BYPASSRLS on
-- service_role matches Supabase semantics: RLS only applies after
-- SET ROLE authenticated / anon.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'anon') THEN
    CREATE ROLE anon NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'service_role') THEN
    CREATE ROLE service_role NOLOGIN BYPASSRLS;
  END IF;
END
$$;

-- ─── auth schema ───

CREATE SCHEMA IF NOT EXISTS auth;

-- Superset of what the baseline needs: handle_new_user() reads id, email and
-- raw_user_meta_data (full_name / name / avatar_url / user_name /
-- preferred_username); profiles.id and oauth_provider_tokens.user_id FK onto
-- id. The remaining columns belong to the managed AuthProvider (upcoming).
-- gen_random_uuid() is built into Postgres 13+ (no extension needed here;
-- 001 still creates pgcrypto for its own use).
CREATE TABLE IF NOT EXISTS auth.users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL,
  raw_user_meta_data jsonb NOT NULL DEFAULT '{}'::jsonb,
  provider text,
  provider_account_id text,
  email_verified_at timestamptz,
  last_sign_in_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_key
  ON auth.users (lower(email));
CREATE UNIQUE INDEX IF NOT EXISTS users_provider_account_key
  ON auth.users (provider, provider_account_id)
  WHERE provider IS NOT NULL AND provider_account_id IS NOT NULL;

-- ─── Managed-auth token tables (consumed by the managed AuthProvider) ───

-- Refresh-token rotation with family-wide replay revocation: rotating marks
-- rotated_at and issues a sibling in the same family_id; reuse of a rotated
-- token outside the grace window revokes the whole family.
CREATE TABLE IF NOT EXISTS auth.refresh_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  family_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  rotated_at timestamptz,
  revoked_at timestamptz
);

CREATE INDEX IF NOT EXISTS refresh_tokens_user_id_idx
  ON auth.refresh_tokens (user_id);
CREATE INDEX IF NOT EXISTS refresh_tokens_family_id_idx
  ON auth.refresh_tokens (family_id);

-- Single-use tokens: magic-link sign-in, member invites and the CLI's
-- localhost one-time auth code. user_id is nullable — a magic link to a
-- new address creates the user on redemption, not on issuance.
CREATE TABLE IF NOT EXISTS auth.one_time_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL,
  user_id uuid REFERENCES auth.users (id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  token_type text NOT NULL CHECK (token_type IN ('magic_link', 'invite', 'cli_code')),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz
);

CREATE INDEX IF NOT EXISTS one_time_tokens_email_idx
  ON auth.one_time_tokens (email);

-- ─── auth.uid() ───
-- Exactly the shim 001_baseline.sql documents at its head.
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid
  LANGUAGE sql STABLE
  AS $$
    SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
  $$;

-- ─── Grants ───

GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
GRANT ALL ON ALL TABLES IN SCHEMA auth TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA auth GRANT ALL ON TABLES TO service_role;

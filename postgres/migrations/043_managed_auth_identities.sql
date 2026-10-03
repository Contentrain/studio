-- 043 (plain-Postgres lineage only): every identity a user has signed in with.
--
-- `auth.users.provider / provider_account_id` hold one slot, overwritten by the
-- latest OAuth sign-in: a user who signed in with GitHub and later with Google
-- loses the GitHub id there. Supabase keeps all of them in `auth.identities`;
-- this is the same table (provider, provider_id, user_id) for the managed
-- AuthProvider, so `public.migrate_user_id_by_identity` (supabase/migrations/
-- 043_migrate_identity_lookup.sql) reads one shape on both pairs.
--
-- Existing users are backfilled from the slot they have. Sorts before the
-- lookup function's migration, which reads this table.

CREATE TABLE IF NOT EXISTS auth.identities (
  provider text NOT NULL,
  provider_id text NOT NULL,
  user_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  last_sign_in_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, provider_id)
);

CREATE INDEX IF NOT EXISTS identities_user_id_idx ON auth.identities (user_id);

INSERT INTO auth.identities (provider, provider_id, user_id, last_sign_in_at)
SELECT provider, provider_account_id, id, last_sign_in_at
FROM auth.users
WHERE provider IS NOT NULL AND provider_account_id IS NOT NULL
ON CONFLICT DO NOTHING;

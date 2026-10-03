-- 043: find a Studio user by the id an OAuth provider gave them, in one indexed read.
--
-- Migrate's account-state call (S1) knows only a GitHub user id. On the Supabase
-- pair that id lives in `auth.identities` (provider + provider_id), which holds
-- every identity a user has — including a GitHub account linked after they
-- signed up another way. The admin API can only list users page by page, so the
-- lookup is a function the service role calls. On the plain-Postgres pair
-- `auth.users` carries the identity itself and needs no function.
--
-- plpgsql, not sql: `auth.identities` exists on Supabase only, and the plain-PG
-- lineage (auth shim) must still create this function without it.
-- Service-role only.

CREATE OR REPLACE FUNCTION public.migrate_user_id_by_identity(p_provider text, p_account_id text)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER STABLE
SET search_path = public, auth
AS $$
DECLARE
  v_user uuid;
BEGIN
  SELECT user_id INTO v_user
  FROM auth.identities
  WHERE provider = p_provider AND provider_id = p_account_id
  ORDER BY last_sign_in_at DESC NULLS LAST
  LIMIT 1;
  RETURN v_user;
END;
$$;

REVOKE ALL ON FUNCTION public.migrate_user_id_by_identity(text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.migrate_user_id_by_identity(text, text) TO service_role;

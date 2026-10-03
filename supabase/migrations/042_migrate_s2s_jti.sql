-- 042: replay record for Migrate's server-to-server requests.
--
-- Migrate signs each request it makes to Studio (account-state, provision,
-- grant status/revoke) with a one-use `jti`. A claim is single-use per order,
-- enforced by `migrate_grants`; these calls have no such row, so the `jti` is
-- remembered here until the token could no longer verify, and a repeat is
-- refused. The `jti` is the key, so a token cannot be replayed on another
-- endpoint either; `purpose` only records which endpoint took it (support).
--
-- Service-role only: RLS on, no policies, like `migrate_grants`.

CREATE TABLE public.migrate_s2s_jti (
  jti text PRIMARY KEY,
  purpose text NOT NULL,
  expires_at timestamp with time zone NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX idx_migrate_s2s_jti_expiry ON public.migrate_s2s_jti (expires_at);

ALTER TABLE public.migrate_s2s_jti ENABLE ROW LEVEL SECURITY;

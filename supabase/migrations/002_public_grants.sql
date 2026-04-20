-- Public schema role grants for Supabase-compatible deployments.
--
-- Why this migration exists: `001_baseline.sql` was generated with
-- `pg_dump --schema=public --schema-only` which omits `GRANT` / `ALTER
-- DEFAULT PRIVILEGES` statements (pg_dump skips role-level ACL on
-- schema-only dumps in several common scenarios). Without these grants,
-- the `authenticated` and `anon` roles cannot see any table in `public`
-- even when RLS policies would otherwise allow it — the request fails
-- with `permission denied for table <name>` before row-level checks
-- ever run.
--
-- This file re-applies the Supabase-standard grants that a fresh
-- Supabase project gets automatically. RLS still filters rows per
-- policy; these grants just unlock the baseline table/sequence/function
-- access that RLS layers on top of.
--
-- Safe on plain Postgres with the auth shim in `001_baseline.sql` — the
-- `service_role` grant is a no-op when the role does not exist, but
-- that path would be a custom deployment anyway.

GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;

GRANT ALL ON ALL TABLES IN SCHEMA public TO anon, authenticated, service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO anon, authenticated, service_role;
GRANT ALL ON ALL FUNCTIONS IN SCHEMA public TO anon, authenticated, service_role;

-- Future tables / sequences / functions created under `public` inherit
-- the same grants. Without these ALTER DEFAULT PRIVILEGES lines every
-- new migration would have to re-add GRANT by hand.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon, authenticated, service_role;

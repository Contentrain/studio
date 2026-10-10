-- 050: retries and the ops alarm for a bundle grant's site binding (049).
--
-- A bundle site whose first bind fails must not stay silently dead. The sweep
-- (`server/plugins/migrate-site-binding-sweep.ts`) binds connected sites that
-- were never bound and retries `failed` ones with backoff, up to a cap. It
-- raises the ops alarm once per grant: after the third failed attempt in a row,
-- or on any `conflict` (a person decides; the sweep never touches it).
--
--   site_binding_attempts    failed attempts in a row; a binding that goes through resets it
--   site_binding_next_at     the earliest time the sweep tries a `failed` binding again
--   site_binding_alerted_at  when the alarm went out (once per grant; cleared once the binding is written)
--
-- Service-role only like the rest of the table.

ALTER TABLE public.migrate_grants
  ADD COLUMN site_binding_attempts integer NOT NULL DEFAULT 0 CHECK (site_binding_attempts >= 0),
  ADD COLUMN site_binding_next_at timestamp with time zone,
  ADD COLUMN site_binding_alerted_at timestamp with time zone;

-- The sweep's work list (`listMigrateSiteBindingWork`): redeemed bundle grants with no binding, a failed one or a
-- conflict, by their next retry time.
CREATE INDEX idx_migrate_grants_site_binding_work ON public.migrate_grants (site_binding_next_at)
  WHERE kind = 'bundle' AND redeemed_at IS NOT NULL AND revoked_at IS NULL AND workspace_id IS NOT NULL
    AND (site_binding_state IS NULL OR site_binding_state IN ('failed', 'conflict'));

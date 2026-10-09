-- 049: a bundle grant's site binding (forms work on the delivered site).
--
-- When a "Migrate with Studio" bundle's delivered repository becomes a Studio
-- project (`connect-project`), Studio writes `studio.json` { baseUrl, projectId }
-- to the site so the starter binds its forms and comments to that project
-- (`server/utils/migrate-site-binding.ts`). The grant remembers how that went, so
-- the claim screen can say it and a retry knows where it stands:
--
--   written   studio.json on the site points at this project (written now, or already there)
--   partial   written, but more form models than the plan serves: those say "needs a plan upgrade"
--   pr_open   the site's default branch is protected: a pull request carries the same single file
--   conflict  studio.json there points at another project or cannot be read: left untouched
--   failed    the write did not go through (the claim screen offers a retry)
--
-- `site_binding_detail` holds what the screen and support read (the pull request's
-- address, the values a conflicting file holds, the form-model count and limit, an
-- error code). Never secrets. Service-role only like the rest of the table.

ALTER TABLE public.migrate_grants
  ADD COLUMN site_binding_state text,
  ADD COLUMN site_binding_detail jsonb,
  ADD COLUMN site_binding_at timestamp with time zone;

ALTER TABLE public.migrate_grants
  ADD CONSTRAINT migrate_grants_site_binding_shape CHECK (
    (site_binding_state IS NULL AND site_binding_at IS NULL)
    OR (site_binding_state IN ('written', 'partial', 'pr_open', 'conflict', 'failed') AND site_binding_at IS NOT NULL)
  );

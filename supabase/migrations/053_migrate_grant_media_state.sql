-- 053: where a bundle grant's media move stands (G2, G3).
--
-- A bundle site's media moves to Studio on its own (052): the import starts when the
-- site is connected, and a done grant job is applied through the project's write path.
-- Nothing remembered how that went, so a failed start was never tried again and an
-- import paused for storage waited for a click. The site-binding sweep now also walks
-- the grants whose media is not settled (`sweepMigrateGrantMedia`) and records here
-- what it found, from the project's latest import job whoever started it:
--
--   none          nothing to move (no media manifest, or no file Studio takes)
--   importing     the job is preparing, queued or running
--   paused_quota  the job waits for storage; the sweep resumes it once the workspace has room
--   failed        the start or the grant's job failed; tried again with backoff, up to a cap
--   pending       the job is done but its addresses are not on the site yet and nothing is
--                 waiting for a reviewer (an owner's own import not applied, an owner's cancel)
--   review        the apply is on a cr/media branch or an open pull request
--   connected     every file Studio took is moved and its apply has landed
--
-- `media_detail` holds what support and the status route read (the job id, the apply's
-- branch and pull request, an error code). Never secrets. Service-role only like the
-- rest of the table.
--
--   media_attempts    failed attempts in a row; a start that goes through resets it
--   media_next_at     the earliest time the sweep tries a `failed` one again
--   media_alerted_at  when the ops alarm went out (once per grant)

ALTER TABLE public.migrate_grants
  ADD COLUMN media_state text,
  ADD COLUMN media_detail jsonb,
  ADD COLUMN media_at timestamp with time zone,
  ADD COLUMN media_attempts integer NOT NULL DEFAULT 0 CHECK (media_attempts >= 0),
  ADD COLUMN media_next_at timestamp with time zone,
  ADD COLUMN media_alerted_at timestamp with time zone;

ALTER TABLE public.migrate_grants
  ADD CONSTRAINT migrate_grants_media_shape CHECK (
    (media_state IS NULL AND media_at IS NULL)
    OR (media_state IN ('none', 'importing', 'paused_quota', 'failed', 'pending', 'review', 'connected') AND media_at IS NOT NULL)
  );

-- The media sweep's work list (`listMigrateGrantMediaWork`): connected bundle sites whose media is not settled.
CREATE INDEX idx_migrate_grants_media_work ON public.migrate_grants (media_next_at)
  WHERE kind = 'bundle' AND redeemed_at IS NOT NULL AND revoked_at IS NULL AND workspace_id IS NOT NULL
    AND site_binding_state IS NOT NULL AND (media_state IS NULL OR media_state NOT IN ('none', 'connected'));

-- Delete-safe FK actions — three latent failures surfaced by the postgres
-- DatabaseProvider contract suite exercising real cascade chains:
--
-- 1. form_submissions.approved_by → profiles(id) had NO ON DELETE action,
--    so GDPR account deletion (auth.users → profiles cascade) FAILS for any
--    user who ever approved a form submission. The approval stamp must not
--    outlive-block the approver's account: detach it instead.
--
-- 2. media_assets.uploaded_by → profiles(id): same blocker for any user who
--    ever uploaded media. Column becomes nullable so the uploader reads as
--    "deleted user" after account deletion, like approved_by.
--
-- 3. cdn_usage.api_key_id ON DELETE SET NULL collides with the partial
--    unique index cdn_usage_project_period_public_key (project_id,
--    period_start WHERE api_key_id IS NULL): when a project delete cascades
--    into cdn_api_keys, the SET NULL rewrites keyed usage rows into "public"
--    rows mid-cascade and violates the index if a public row already exists
--    for that day — failing the whole project deletion. Keys are only ever
--    hard-deleted by the project cascade (the app soft-revokes), and that
--    same cascade removes the usage rows anyway → CASCADE is the consistent
--    action.

ALTER TABLE public.form_submissions
  DROP CONSTRAINT form_submissions_approved_by_fkey;
ALTER TABLE public.form_submissions
  ADD CONSTRAINT form_submissions_approved_by_fkey
    FOREIGN KEY (approved_by) REFERENCES public.profiles(id) ON DELETE SET NULL;

ALTER TABLE public.media_assets
  ALTER COLUMN uploaded_by DROP NOT NULL;
ALTER TABLE public.media_assets
  DROP CONSTRAINT media_assets_uploaded_by_fkey;
ALTER TABLE public.media_assets
  ADD CONSTRAINT media_assets_uploaded_by_fkey
    FOREIGN KEY (uploaded_by) REFERENCES public.profiles(id) ON DELETE SET NULL;

ALTER TABLE public.cdn_usage
  DROP CONSTRAINT cdn_usage_api_key_id_fkey;
ALTER TABLE public.cdn_usage
  ADD CONSTRAINT cdn_usage_api_key_id_fkey
    FOREIGN KEY (api_key_id) REFERENCES public.cdn_api_keys(id) ON DELETE CASCADE;

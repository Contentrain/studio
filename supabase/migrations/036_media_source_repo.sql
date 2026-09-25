-- 036: a media asset can come from the project's own repository.
--
-- A migration commits the site's images into the repository (public/media/…);
-- moving them into Studio Media reads those blobs straight from Git rather than
-- re-fetching the old WordPress URLs, which may already be gone. Such an asset
-- is neither an upload nor a URL fetch, so it gets its own source.

ALTER TABLE public.media_assets DROP CONSTRAINT IF EXISTS media_assets_source_check;
ALTER TABLE public.media_assets
  ADD CONSTRAINT media_assets_source_check
  CHECK (source = ANY (ARRAY['upload'::text, 'url'::text, 'connector'::text, 'agent'::text, 'repo'::text]));

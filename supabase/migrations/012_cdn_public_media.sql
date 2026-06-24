-- 012_cdn_public_media.sql
-- Allow no-auth (public) delivery of media binaries via /api/cdn/v1/...
--
-- Background: CDN delivery (/api/cdn/v1/{projectId}/{path}) is Bearer-keyed
-- for every object. That is correct for content JSON (a build tool fetches it
-- server-side with a key), but it makes uploaded media assets unusable in the
-- one place they must work: a browser <img src> on a published site. A key
-- cannot live in an <img> tag, so without a public delivery mode an asset can
-- only be shown by proxying every image through the consumer's own server.
--
-- Published media is public by nature (anyone visiting the site sees it), so
-- this flag opts a project into serving its `media/*` objects without a key.
-- Content JSON and the media manifest stay keyed — only media binaries become
-- public. The cdn.delivery PLAN feature still gates the capability, so this is
-- not a way to bypass entitlement; it only changes the auth model for already
-- entitled, CDN-enabled projects.
--
-- Default true: media is meant to be consumed. Operators who need keyed-only
-- delivery (e.g. gated/private media) flip this off per project.

ALTER TABLE public.projects
  ADD COLUMN IF NOT EXISTS cdn_public_media boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN public.projects.cdn_public_media IS
  'When true, media/* objects are served without a CDN API key (public <img> delivery). Content JSON and the media manifest remain key-gated. Gated additionally by the cdn.delivery plan feature and cdn_enabled.';

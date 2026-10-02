-- 040: the bytes an image upload arrived as are kept, privately.
--
-- `original_path` is the delivery master: the re-encoded, metadata-stripped WebP the site serves (`media/original/…`).
-- Its name stays — content fields store that path. The uploaded file itself, byte for byte, is stored apart from
-- public delivery and recorded here. Null = no stored source: every asset created before this change, and files
-- that are stored as uploaded anyway (SVG after sanitising, video, PDF).
--
-- `size_bytes` stays the asset's total storage use and now includes `source_size_bytes`, so the workspace
-- storage counter and the delete path need no new arithmetic.

ALTER TABLE public.media_assets
  ADD COLUMN IF NOT EXISTS source_path text,
  ADD COLUMN IF NOT EXISTS source_size_bytes bigint;

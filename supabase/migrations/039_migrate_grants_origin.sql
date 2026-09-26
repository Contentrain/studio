-- 039: the migrated site's origin, as Migrate signed it (claim `origin`).
--
-- Media import (038) fetches files left at the old site from one origin. That
-- origin came from media.json — the customer's repository, so anyone with push
-- access could point Studio's server at a host of their choosing. The claim
-- token is signed by Migrate; its `origin` is stored here and is the only host
-- a media fetch may reach. A grant without one (an older order, or an origin
-- Migrate could not vouch for) queues no files from the old site.
--
-- `migration_media_jobs.origin` (038) now holds a copy of this value, taken
-- when the job starts, not the manifest's.

ALTER TABLE public.migrate_grants ADD COLUMN origin text;

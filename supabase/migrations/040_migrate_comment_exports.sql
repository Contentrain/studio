-- 040: a Migrate delivery's comments export, held for the project it belongs to (İP-2c).
--
-- The export never enters git: Migrate serves it from a fixed address, and the
-- claim token carries a bearer token for it. That bearer is never stored, so
-- Studio fetches the export while the claim is made — before the project it
-- belongs to exists — and holds the payload here until it is imported.
--
-- One row per grant:
--   ready       — `payload` holds the export (`contentrain-comments@1`, personal
--                 data already stripped by Migrate), waiting for the project.
--   unavailable — the fetch failed or the export was unusable; `payload` null.
--                 The project's comments settings offer the file upload.
--   imported    — landed in the project's comments; `payload` cleared at once.
--   expired     — never imported before `expires_at` (the grant window);
--                 `payload` cleared lazily.
--
-- Service-role only: RLS on, no policies, like `migrate_grants`.

CREATE TABLE public.migrate_comment_exports (
  grant_id uuid PRIMARY KEY REFERENCES public.migrate_grants(id) ON DELETE CASCADE,
  status text NOT NULL CHECK (status IN ('ready', 'unavailable', 'imported', 'expired')),
  payload jsonb,
  comments integer NOT NULL DEFAULT 0 CHECK (comments >= 0),
  expires_at timestamp with time zone NOT NULL,
  fetched_at timestamp with time zone NOT NULL DEFAULT now(),
  imported_at timestamp with time zone,
  CONSTRAINT migrate_comment_exports_payload CHECK ((status = 'ready') = (payload IS NOT NULL))
);

CREATE INDEX idx_migrate_comment_exports_expiry ON public.migrate_comment_exports (expires_at) WHERE payload IS NOT NULL;

ALTER TABLE public.migrate_comment_exports ENABLE ROW LEVEL SECURITY;

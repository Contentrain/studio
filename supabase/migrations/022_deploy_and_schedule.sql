-- Deploy hooks + scheduled publication boundaries — SHARED lineage (both pairs).
--
-- S-02: a project can carry one deploy target — a build-hook URL the site
-- host exposes (Netlify, Vercel, Cloudflare Pages, or any POST endpoint).
-- Studio POSTs it after content lands on `contentrain` and at scheduled
-- publish/expire boundaries, so a static site rebuilds without a commit.
-- The URL is a secret: it is stored encrypted (AES-GCM, session secret)
-- inside `deploy_target`, and only a hint is ever read back.
--
-- S-03: `publish_at` / `expire_at` live in entry meta (Git). Delivery already
-- gates on them at build time, but nothing rebuilt the site when the
-- boundary passed. Every save that carries a future boundary registers it
-- here; a scheduler claims due rows atomically (safe across instances) and
-- triggers a CDN rebuild + the deploy hook. Rows are claimed whenever due,
-- however late — a restart never loses a boundary, it only delays it.

ALTER TABLE public.projects
  ADD COLUMN deploy_target jsonb;

-- The scheduler claims builds like the webhook and the manual button do.
ALTER TABLE public.cdn_builds DROP CONSTRAINT cdn_builds_trigger_type_check;
ALTER TABLE public.cdn_builds
  ADD CONSTRAINT cdn_builds_trigger_type_check CHECK ((trigger_type = ANY (ARRAY['webhook'::text, 'manual'::text, 'api'::text, 'schedule'::text])));

CREATE TABLE public.scheduled_publications (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    project_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    model_id text NOT NULL,
    entry_id text NOT NULL,
    locale text DEFAULT 'en'::text NOT NULL,
    kind text NOT NULL,
    fire_at timestamp with time zone NOT NULL,
    fired_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT scheduled_publications_kind_check CHECK ((kind = ANY (ARRAY['publish'::text, 'expire'::text])))
);

ALTER TABLE ONLY public.scheduled_publications
    ADD CONSTRAINT scheduled_publications_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.scheduled_publications
    ADD CONSTRAINT scheduled_publications_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.scheduled_publications
    ADD CONSTRAINT scheduled_publications_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;

-- One boundary per entry+locale+kind; a re-save replaces it.
CREATE UNIQUE INDEX scheduled_publications_entry_kind_key ON public.scheduled_publications USING btree (project_id, model_id, entry_id, locale, kind);

-- The scheduler's scan: due and not yet fired.
CREATE INDEX idx_scheduled_publications_due ON public.scheduled_publications USING btree (fire_at) WHERE (fired_at IS NULL);

ALTER TABLE public.scheduled_publications ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Workspace members can view scheduled publications" ON public.scheduled_publications FOR SELECT USING ((workspace_id IN ( SELECT wm.workspace_id
   FROM public.workspace_members wm
  WHERE (wm.user_id = auth.uid()))));

-- Claim every due boundary in one statement. SKIP LOCKED keeps two
-- instances from firing the same row; the returned rows are the caller's.
CREATE FUNCTION public.claim_due_scheduled_publications(p_now timestamp with time zone, p_limit integer) RETURNS SETOF public.scheduled_publications
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
BEGIN
  RETURN QUERY
  WITH due AS (
    SELECT id
      FROM public.scheduled_publications
     WHERE fired_at IS NULL
       AND fire_at <= p_now
     ORDER BY fire_at
     LIMIT p_limit
     FOR UPDATE SKIP LOCKED
  )
  UPDATE public.scheduled_publications sp
     SET fired_at = p_now,
         updated_at = p_now
    FROM due
   WHERE sp.id = due.id
  RETURNING sp.*;
END;
$$;

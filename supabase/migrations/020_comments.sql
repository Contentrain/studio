-- Comments v1 — SHARED lineage (both provider pairs).
--
-- Studio-managed comments for content entries: the runtime half of the
-- "comments" capability a migrated WordPress site would otherwise lose.
-- Comments live in the Studio DB, never in Git (data ownership §69.6); the
-- per-model *configuration* (enabled, moderation, captcha, depth) lives on
-- the model definition in the repo, exactly like `form`.
--
-- Two tables:
--   comments         one row per comment; `parent_id` chains replies,
--                    `root_id` + `depth` are materialised so a page of
--                    top-level threads and their subtrees is one range scan.
--   comment_threads  per-entry state (closed_at) — a row only exists once a
--                    thread has been closed/reopened; absent = open. Carries
--                    WordPress `comment_status: closed` across a migration.
--
-- Two SECURITY DEFINER functions, mirroring create_form_submission_if_allowed:
--   create_comment_if_allowed  public submit path — monthly quota + thread
--                              closed + parent resolution + depth cap, atomic
--                              under a per-workspace advisory lock.
--   import_comments            WordPress import — flat insert (idempotent on
--                              project+source+source_id), parents re-linked
--                              from the source ids in a second pass, then
--                              root/depth recomputed for the touched threads.
--                              Never drops a record, never clamps depth: the
--                              import fidelity criterion is "zero record and
--                              zero parent loss"; the depth cap only gates
--                              NEW public submissions.
--
-- Chain integrity for every insert path (public RPC, moderator reply, import)
-- is enforced by one BEFORE INSERT trigger: a reply inherits root/depth from
-- its parent and must target the same entry.

-- ── comments ──────────────────────────────────────────────────────────────

CREATE TABLE public.comments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    project_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    model_id text NOT NULL,
    entry_id text NOT NULL,
    locale text DEFAULT 'en'::text NOT NULL,
    parent_id uuid,
    root_id uuid NOT NULL,
    depth integer DEFAULT 0 NOT NULL,
    author_name text NOT NULL,
    author_email text,
    author_url text,
    author_user_id uuid,
    body text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    type text DEFAULT 'comment'::text NOT NULL,
    source text DEFAULT 'web'::text NOT NULL,
    source_id text,
    source_parent_id text,
    source_ip inet,
    user_agent text,
    referrer text,
    moderated_at timestamp with time zone,
    moderated_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT comments_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'approved'::text, 'spam'::text, 'rejected'::text]))),
    CONSTRAINT comments_type_check CHECK ((type = ANY (ARRAY['comment'::text, 'pingback'::text, 'trackback'::text]))),
    CONSTRAINT comments_source_check CHECK ((source = ANY (ARRAY['web'::text, 'import'::text, 'studio'::text]))),
    CONSTRAINT comments_depth_check CHECK ((depth >= 0)),
    CONSTRAINT comments_author_name_check CHECK ((char_length(author_name) BETWEEN 1 AND 120)),
    CONSTRAINT comments_body_check CHECK ((char_length(body) BETWEEN 1 AND 20000))
);

ALTER TABLE ONLY public.comments
    ADD CONSTRAINT comments_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.comments
    ADD CONSTRAINT comments_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.comments
    ADD CONSTRAINT comments_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;

-- Removing a comment removes its replies: a moderator deleting an abusive
-- thread expects the whole branch to go, and a dangling reply to nothing
-- cannot be rendered.
ALTER TABLE ONLY public.comments
    ADD CONSTRAINT comments_parent_id_fkey FOREIGN KEY (parent_id) REFERENCES public.comments(id) ON DELETE CASCADE;

-- Delete-safe (015 lesson): an author's or moderator's account deletion must
-- never be blocked by a comment stamp.
ALTER TABLE ONLY public.comments
    ADD CONSTRAINT comments_author_user_id_fkey FOREIGN KEY (author_user_id) REFERENCES public.profiles(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.comments
    ADD CONSTRAINT comments_moderated_by_fkey FOREIGN KEY (moderated_by) REFERENCES public.profiles(id) ON DELETE SET NULL;

-- Public read: one entry's approved comments in thread order.
CREATE INDEX idx_comments_entry ON public.comments USING btree (project_id, model_id, entry_id, locale, status, created_at);

-- Moderation queue: newest first per project (+ status filter).
CREATE INDEX idx_comments_project_status ON public.comments USING btree (project_id, status, created_at DESC);

-- Subtree fetch for a page of root comments.
CREATE INDEX idx_comments_root ON public.comments USING btree (root_id, created_at);

-- Monthly quota (public submissions only).
CREATE INDEX idx_comments_workspace_created ON public.comments USING btree (workspace_id, created_at);

-- Import idempotency: one row per source record per project.
CREATE UNIQUE INDEX comments_project_source_id_key ON public.comments USING btree (project_id, source, source_id) WHERE (source_id IS NOT NULL);

-- ── comment_threads ───────────────────────────────────────────────────────

CREATE TABLE public.comment_threads (
    project_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    model_id text NOT NULL,
    entry_id text NOT NULL,
    locale text DEFAULT 'en'::text NOT NULL,
    closed_at timestamp with time zone,
    closed_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.comment_threads
    ADD CONSTRAINT comment_threads_pkey PRIMARY KEY (project_id, model_id, entry_id, locale);

ALTER TABLE ONLY public.comment_threads
    ADD CONSTRAINT comment_threads_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.comment_threads
    ADD CONSTRAINT comment_threads_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.comment_threads
    ADD CONSTRAINT comment_threads_closed_by_fkey FOREIGN KEY (closed_by) REFERENCES public.profiles(id) ON DELETE SET NULL;

-- ── chain integrity trigger ───────────────────────────────────────────────

CREATE FUNCTION public.comments_before_insert() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
DECLARE
  v_parent public.comments;
BEGIN
  IF NEW.parent_id IS NULL THEN
    NEW.root_id := NEW.id;
    NEW.depth := 0;
    RETURN NEW;
  END IF;

  SELECT * INTO v_parent FROM public.comments WHERE id = NEW.parent_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'comments_parent_not_found' USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF v_parent.project_id <> NEW.project_id
     OR v_parent.model_id <> NEW.model_id
     OR v_parent.entry_id <> NEW.entry_id
     OR v_parent.locale <> NEW.locale THEN
    RAISE EXCEPTION 'comments_parent_mismatch' USING ERRCODE = 'check_violation';
  END IF;

  NEW.root_id := v_parent.root_id;
  NEW.depth := v_parent.depth + 1;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_comments_before_insert BEFORE INSERT ON public.comments FOR EACH ROW EXECUTE FUNCTION public.comments_before_insert();

-- ── audit (mirrors audit_form_submission_delete) ─────────────────────────

CREATE FUNCTION public.audit_comment_delete() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
BEGIN
  INSERT INTO public.audit_logs (
    workspace_id,
    actor_id,
    action,
    table_name,
    record_id,
    record_snapshot,
    origin
  ) VALUES (
    OLD.workspace_id,
    NULLIF(current_setting('app.audit_actor_id', true), '')::UUID,
    'delete_comment',
    'comments',
    OLD.id,
    row_to_json(OLD)::JSONB,
    CASE
      WHEN current_setting('app.audit_actor_id', true) IS NOT NULL
        AND current_setting('app.audit_actor_id', true) != ''
      THEN 'app'
      ELSE 'cascade'
    END
  );
  RETURN OLD;
END;
$$;

CREATE TRIGGER trg_audit_comment_delete BEFORE DELETE ON public.comments FOR EACH ROW EXECUTE FUNCTION public.audit_comment_delete();

-- ── RLS (parity with form_submissions) ───────────────────────────────────

ALTER TABLE public.comments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.comment_threads ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Workspace members can view comments" ON public.comments FOR SELECT USING ((workspace_id IN ( SELECT wm.workspace_id
   FROM public.workspace_members wm
  WHERE (wm.user_id = auth.uid()))));

CREATE POLICY "Workspace admin can insert comments" ON public.comments FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM public.workspace_members wm
  WHERE ((wm.workspace_id = comments.workspace_id) AND (wm.user_id = auth.uid()) AND (wm.role = ANY (ARRAY['owner'::text, 'admin'::text]))))));

CREATE POLICY "Workspace admin can update comments" ON public.comments FOR UPDATE USING ((EXISTS ( SELECT 1
   FROM public.workspace_members wm
  WHERE ((wm.workspace_id = comments.workspace_id) AND (wm.user_id = auth.uid()) AND (wm.role = ANY (ARRAY['owner'::text, 'admin'::text]))))));

CREATE POLICY "Workspace admin can delete comments" ON public.comments FOR DELETE USING ((EXISTS ( SELECT 1
   FROM public.workspace_members wm
  WHERE ((wm.workspace_id = comments.workspace_id) AND (wm.user_id = auth.uid()) AND (wm.role = ANY (ARRAY['owner'::text, 'admin'::text]))))));

CREATE POLICY "Workspace members can view comment threads" ON public.comment_threads FOR SELECT USING ((workspace_id IN ( SELECT wm.workspace_id
   FROM public.workspace_members wm
  WHERE (wm.user_id = auth.uid()))));

CREATE POLICY "Workspace admin can manage comment threads" ON public.comment_threads USING ((EXISTS ( SELECT 1
   FROM public.workspace_members wm
  WHERE ((wm.workspace_id = comment_threads.workspace_id) AND (wm.user_id = auth.uid()) AND (wm.role = ANY (ARRAY['owner'::text, 'admin'::text])))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM public.workspace_members wm
  WHERE ((wm.workspace_id = comment_threads.workspace_id) AND (wm.user_id = auth.uid()) AND (wm.role = ANY (ARRAY['owner'::text, 'admin'::text]))))));

-- ── create_comment_if_allowed ─────────────────────────────────────────────
--
-- Returns jsonb:
--   { allowed: true,  current_count, comment }
--   { allowed: false, reason: 'thread_closed' | 'parent_not_found' | 'depth_exceeded' | 'monthly_limit', current_count? }
--
-- Only `source = 'web'` rows count against the monthly quota: an import is a
-- one-off migration and a moderator's reply is staff work, neither is what
-- the plan limit prices.

CREATE FUNCTION public.create_comment_if_allowed(
  p_workspace_id uuid,
  p_monthly_limit integer,
  p_project_id uuid,
  p_model_id text,
  p_entry_id text,
  p_locale text,
  p_parent_id uuid,
  p_max_depth integer,
  p_author_name text,
  p_author_email text,
  p_author_url text,
  p_body text,
  p_status text DEFAULT 'pending'::text,
  p_source_ip inet DEFAULT NULL::inet,
  p_user_agent text DEFAULT NULL::text,
  p_referrer text DEFAULT NULL::text
) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE
  v_count INTEGER;
  v_parent public.comments;
  v_comment public.comments;
BEGIN
  -- Serialize concurrent submissions for the same workspace.
  PERFORM pg_advisory_xact_lock(
    hashtext('cm:' || p_workspace_id::text)
  );

  IF EXISTS (
    SELECT 1 FROM public.comment_threads t
     WHERE t.project_id = p_project_id
       AND t.model_id = p_model_id
       AND t.entry_id = p_entry_id
       AND t.locale = p_locale
       AND t.closed_at IS NOT NULL
  ) THEN
    RETURN jsonb_build_object('allowed', false, 'reason', 'thread_closed');
  END IF;

  IF p_parent_id IS NOT NULL THEN
    SELECT * INTO v_parent
      FROM public.comments
     WHERE id = p_parent_id
       AND project_id = p_project_id
       AND model_id = p_model_id
       AND entry_id = p_entry_id
       AND locale = p_locale;
    IF NOT FOUND OR v_parent.status <> 'approved' THEN
      RETURN jsonb_build_object('allowed', false, 'reason', 'parent_not_found');
    END IF;
    IF v_parent.depth + 1 > p_max_depth THEN
      RETURN jsonb_build_object('allowed', false, 'reason', 'depth_exceeded');
    END IF;
  END IF;

  SELECT COUNT(*) INTO v_count
    FROM public.comments
   WHERE workspace_id = p_workspace_id
     AND source = 'web'
     AND created_at >= date_trunc('month', now())
     AND created_at < date_trunc('month', now()) + interval '1 month';

  IF v_count >= p_monthly_limit THEN
    RETURN jsonb_build_object('allowed', false, 'reason', 'monthly_limit', 'current_count', v_count);
  END IF;

  INSERT INTO public.comments (
    project_id, workspace_id, model_id, entry_id, locale, parent_id,
    author_name, author_email, author_url, body, status, source,
    source_ip, user_agent, referrer
  )
  VALUES (
    p_project_id, p_workspace_id, p_model_id, p_entry_id, p_locale, p_parent_id,
    p_author_name, p_author_email, p_author_url, p_body, p_status, 'web',
    p_source_ip, p_user_agent, p_referrer
  )
  RETURNING * INTO v_comment;

  RETURN jsonb_build_object(
    'allowed', true,
    'current_count', v_count + 1,
    'comment', to_jsonb(v_comment)
  );
END;
$$;

-- ── import_comments ───────────────────────────────────────────────────────
--
-- p_payload: {
--   comments: [{ source_id, source_parent_id, model_id, entry_id, locale,
--                author_name, author_email, author_url, body, status, type, created_at }],
--   threads_closed: [{ model_id, entry_id, locale }]
-- }
-- Rows arrive already mapped to their entry (the caller resolves WordPress
-- post ids through the export's EntrySourceMap and reports the unmapped ones
-- itself). Returns jsonb:
--   { inserted, skipped_existing, orphan_count, orphan_parents: [{source_id, source_parent_id}] (≤100),
--     max_depth, threads_closed }
--
-- Pass 1 inserts every row flat (parent_id NULL → the insert trigger makes it
-- its own root); ON CONFLICT on the source id makes re-runs and chunked
-- uploads safe. Pass 2 links parents by source id across ALL of the
-- project's imported rows, so a parent that arrives in a later chunk still
-- gets its children attached. Pass 3 recomputes root_id/depth for every
-- thread of the touched entries with one recursive walk.

CREATE FUNCTION public.import_comments(
  p_project_id uuid,
  p_workspace_id uuid,
  p_payload jsonb
) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE
  v_total INTEGER := 0;
  v_inserted INTEGER := 0;
  v_orphan_count INTEGER := 0;
  v_orphans jsonb := '[]'::jsonb;
  v_max_depth INTEGER := 0;
  v_threads INTEGER := 0;
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtext('cm-import:' || p_project_id::text)
  );

  DROP TABLE IF EXISTS pg_temp._cm_import;
  CREATE TEMP TABLE _cm_import ON COMMIT DROP AS
    SELECT
      r.source_id,
      r.source_parent_id,
      r.model_id,
      r.entry_id,
      COALESCE(r.locale, 'en') AS locale,
      r.author_name,
      r.author_email,
      r.author_url,
      r.body,
      COALESCE(r.status, 'pending') AS status,
      COALESCE(r.type, 'comment') AS type,
      COALESCE(r.created_at, now()) AS created_at
    FROM jsonb_to_recordset(COALESCE(p_payload->'comments', '[]'::jsonb)) AS r(
      source_id text,
      source_parent_id text,
      model_id text,
      entry_id text,
      locale text,
      author_name text,
      author_email text,
      author_url text,
      body text,
      status text,
      type text,
      created_at timestamp with time zone
    );

  SELECT COUNT(*) INTO v_total FROM pg_temp._cm_import;

  -- Pass 1: flat insert, idempotent on (project, source, source_id).
  INSERT INTO public.comments (
    project_id, workspace_id, model_id, entry_id, locale,
    author_name, author_email, author_url, body, status, type, source,
    source_id, source_parent_id, created_at, updated_at
  )
  SELECT
    p_project_id, p_workspace_id, i.model_id, i.entry_id, i.locale,
    i.author_name, i.author_email, i.author_url, i.body, i.status, i.type, 'import',
    i.source_id, i.source_parent_id, i.created_at, i.created_at
  FROM pg_temp._cm_import i
  ON CONFLICT (project_id, source, source_id) WHERE (source_id IS NOT NULL) DO NOTHING;
  GET DIAGNOSTICS v_inserted = ROW_COUNT;

  -- Pass 2: link parents by source id (same entry only; project-wide so
  -- earlier chunks pick up parents that arrive now).
  UPDATE public.comments c
     SET parent_id = p.id
    FROM public.comments p
   WHERE c.project_id = p_project_id
     AND c.source = 'import'
     AND c.parent_id IS NULL
     AND c.source_parent_id IS NOT NULL
     AND p.project_id = p_project_id
     AND p.source = 'import'
     AND p.source_id = c.source_parent_id
     AND p.model_id = c.model_id
     AND p.entry_id = c.entry_id
     AND p.locale = c.locale
     AND p.id <> c.id;

  -- Pass 3: recompute root/depth for every thread of the touched entries.
  WITH RECURSIVE touched AS (
    SELECT DISTINCT model_id, entry_id, locale FROM pg_temp._cm_import
  ), tree AS (
    SELECT c.id, c.id AS root_id, 0 AS depth
      FROM public.comments c
      JOIN touched t ON t.model_id = c.model_id AND t.entry_id = c.entry_id AND t.locale = c.locale
     WHERE c.project_id = p_project_id
       AND c.parent_id IS NULL
    UNION ALL
    SELECT c.id, tree.root_id, tree.depth + 1
      FROM public.comments c
      JOIN tree ON c.parent_id = tree.id
  )
  UPDATE public.comments c
     SET root_id = tree.root_id,
         depth = tree.depth
    FROM tree
   WHERE c.id = tree.id
     AND (c.root_id IS DISTINCT FROM tree.root_id OR c.depth <> tree.depth);

  SELECT COALESCE(MAX(c.depth), 0) INTO v_max_depth
    FROM public.comments c
    JOIN (SELECT DISTINCT model_id, entry_id, locale FROM pg_temp._cm_import) t
      ON t.model_id = c.model_id AND t.entry_id = c.entry_id AND t.locale = c.locale
   WHERE c.project_id = p_project_id;

  -- Orphans: a parent reference that resolved to nothing (yet).
  SELECT COUNT(*),
         COALESCE(jsonb_agg(jsonb_build_object('source_id', o.source_id, 'source_parent_id', o.source_parent_id)) FILTER (WHERE o.rn <= 100), '[]'::jsonb)
    INTO v_orphan_count, v_orphans
    FROM (
      SELECT c.source_id, c.source_parent_id, row_number() OVER (ORDER BY c.created_at) AS rn
        FROM public.comments c
        JOIN (SELECT DISTINCT model_id, entry_id, locale FROM pg_temp._cm_import) t
          ON t.model_id = c.model_id AND t.entry_id = c.entry_id AND t.locale = c.locale
       WHERE c.project_id = p_project_id
         AND c.source = 'import'
         AND c.parent_id IS NULL
         AND c.source_parent_id IS NOT NULL
    ) o;

  -- Threads closed at the source stay closed here.
  INSERT INTO public.comment_threads (project_id, workspace_id, model_id, entry_id, locale, closed_at)
  SELECT p_project_id, p_workspace_id, r.model_id, r.entry_id, COALESCE(r.locale, 'en'), now()
    FROM jsonb_to_recordset(COALESCE(p_payload->'threads_closed', '[]'::jsonb)) AS r(model_id text, entry_id text, locale text)
  ON CONFLICT (project_id, model_id, entry_id, locale) DO UPDATE
    SET closed_at = COALESCE(public.comment_threads.closed_at, EXCLUDED.closed_at),
        updated_at = now();
  GET DIAGNOSTICS v_threads = ROW_COUNT;

  RETURN jsonb_build_object(
    'inserted', v_inserted,
    'skipped_existing', v_total - v_inserted,
    'orphan_count', v_orphan_count,
    'orphan_parents', v_orphans,
    'max_depth', v_max_depth,
    'threads_closed', v_threads
  );
END;
$$;

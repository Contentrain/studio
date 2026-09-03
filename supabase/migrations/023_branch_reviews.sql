-- Branch review state — SHARED lineage (both pairs).
--
-- S-04: a reviewer can send a pending `cr/*` branch back with a comment
-- ("request changes") instead of only merging or rejecting it. The branch
-- itself lives in Git; the request is Studio state: who asked for what, and
-- whether it was resolved. One row per project + branch; merging or
-- rejecting the branch removes it.

CREATE TABLE public.branch_reviews (
    project_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    branch text NOT NULL,
    status text DEFAULT 'changes_requested'::text NOT NULL,
    comment text NOT NULL,
    requested_by uuid,
    requested_at timestamp with time zone DEFAULT now() NOT NULL,
    resolved_at timestamp with time zone,
    resolved_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT branch_reviews_status_check CHECK ((status = ANY (ARRAY['changes_requested'::text, 'resolved'::text]))),
    CONSTRAINT branch_reviews_comment_check CHECK ((char_length(comment) BETWEEN 1 AND 4000))
);

ALTER TABLE ONLY public.branch_reviews
    ADD CONSTRAINT branch_reviews_pkey PRIMARY KEY (project_id, branch);

ALTER TABLE ONLY public.branch_reviews
    ADD CONSTRAINT branch_reviews_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.branch_reviews
    ADD CONSTRAINT branch_reviews_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.branch_reviews
    ADD CONSTRAINT branch_reviews_requested_by_fkey FOREIGN KEY (requested_by) REFERENCES public.profiles(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.branch_reviews
    ADD CONSTRAINT branch_reviews_resolved_by_fkey FOREIGN KEY (resolved_by) REFERENCES public.profiles(id) ON DELETE SET NULL;

ALTER TABLE public.branch_reviews ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Workspace members can view branch reviews" ON public.branch_reviews FOR SELECT USING ((workspace_id IN ( SELECT wm.workspace_id
   FROM public.workspace_members wm
  WHERE (wm.user_id = auth.uid()))));

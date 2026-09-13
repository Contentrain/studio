-- Approvals and receipts — SHARED lineage (both pairs).
--
-- S-10 / S-11. S-05 moved the auto-merge decision onto the ecosystem's
-- approval evaluator but left it nothing to weigh: the grants list was always
-- empty, so a policy could ask for a review on the diff and a person clicking
-- Merge in the panel still landed the branch with no record that one happened.
--
-- `execution_approvals` is that record. A grant is given for one plan — a
-- pending branch, or a release — identified by its `plan_hash`. There is no
-- plan table: a branch's plan is derived from the branch, so pushing another
-- commit changes its scope, changes the hash, and every grant collected for
-- the old shape stops counting without anything having to invalidate it.
--
-- `approver_email` rather than only the profile id, because the evaluator
-- compares the approver against the plan's author, and the author of a content
-- write is an email (`updated_by` in meta). Two identifier spaces would make
-- self-approval undetectable, which is the one check that has to work.
--
-- `execution_receipts` is what actually ran. It carries the grants inline
-- instead of pointing at them: the approvals are cleared when the branch
-- lands, and an audit record whose evidence can be deleted out from under it
-- is not a record.

CREATE TABLE public.execution_approvals (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    project_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    -- The `cr/*` branch under review, or 'release' for a deploy.
    target text NOT NULL,
    gate text NOT NULL,
    plan_hash text NOT NULL,
    -- The branch tip reviewed. A `change` grant that named another tip is not
    -- a review of what is about to merge.
    commit_sha text,
    approver_id uuid,
    approver_email text NOT NULL,
    approver_role text,
    note text,
    approved_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT execution_approvals_gate_check CHECK ((gate = ANY (ARRAY['plan'::text, 'change'::text, 'release'::text]))),
    CONSTRAINT execution_approvals_note_check CHECK ((note IS NULL OR char_length(note) <= 2000))
);

ALTER TABLE ONLY public.execution_approvals
    ADD CONSTRAINT execution_approvals_pkey PRIMARY KEY (id);

-- One standing decision per person per gate per target: approving again after
-- the branch moved replaces the stale grant rather than stacking beside it.
ALTER TABLE ONLY public.execution_approvals
    ADD CONSTRAINT execution_approvals_unique_approver UNIQUE (project_id, target, gate, approver_email);

ALTER TABLE ONLY public.execution_approvals
    ADD CONSTRAINT execution_approvals_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.execution_approvals
    ADD CONSTRAINT execution_approvals_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.execution_approvals
    ADD CONSTRAINT execution_approvals_approver_id_fkey FOREIGN KEY (approver_id) REFERENCES public.profiles(id) ON DELETE SET NULL;

CREATE INDEX idx_execution_approvals_target ON public.execution_approvals USING btree (project_id, target);

ALTER TABLE public.execution_approvals ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Workspace members can view approvals" ON public.execution_approvals FOR SELECT USING ((workspace_id IN ( SELECT wm.workspace_id
   FROM public.workspace_members wm
  WHERE (wm.user_id = auth.uid()))));

CREATE TABLE public.execution_receipts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    project_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    target text NOT NULL,
    plan_hash text NOT NULL,
    -- The full `ExecutionReceipt` (@contentrain/types): actor, applied scope,
    -- the approvals that permitted it, and the outcome.
    receipt jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.execution_receipts
    ADD CONSTRAINT execution_receipts_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.execution_receipts
    ADD CONSTRAINT execution_receipts_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.execution_receipts
    ADD CONSTRAINT execution_receipts_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;

CREATE INDEX idx_execution_receipts_project ON public.execution_receipts USING btree (project_id, created_at DESC);

ALTER TABLE public.execution_receipts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Workspace members can view receipts" ON public.execution_receipts FOR SELECT USING ((workspace_id IN ( SELECT wm.workspace_id
   FROM public.workspace_members wm
  WHERE (wm.user_id = auth.uid()))));

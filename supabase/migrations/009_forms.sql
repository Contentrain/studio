-- Forms & Submissions: public form endpoints for content-in
-- Submissions are DB-only (not git-synced) for GDPR/PII protection

-- ============================================================
-- FORM SUBMISSIONS
-- Public form data stored per-project. Form config lives in
-- model definition JSON (git), not in the database.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.form_submissions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  model_id TEXT NOT NULL,

  -- Submitted data (validated against model field schema)
  data JSONB NOT NULL,

  -- Moderation status
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'rejected', 'spam')),

  -- Request metadata (privacy-safe logging)
  source_ip INET,
  user_agent TEXT,
  referrer TEXT,
  locale TEXT DEFAULT 'en',

  -- Approval tracking
  approved_at TIMESTAMPTZ,
  approved_by UUID REFERENCES public.profiles(id),
  entry_id TEXT,  -- Content entry ID created after approval

  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Query patterns: list by project+model (newest first), filter by status
CREATE INDEX idx_form_subs_project_model
  ON public.form_submissions(project_id, model_id, created_at DESC);

CREATE INDEX idx_form_subs_status
  ON public.form_submissions(project_id, model_id, status);

-- Monthly submission count: use created_at range queries instead of expression index
-- (date_trunc is STABLE, not IMMUTABLE — cannot be used in index expressions)
CREATE INDEX idx_form_subs_created
  ON public.form_submissions(project_id, created_at);

-- ============================================================
-- RLS POLICIES
-- Submissions are managed via admin client (server-side).
-- Workspace members can view submissions for their projects.
-- ============================================================

ALTER TABLE public.form_submissions ENABLE ROW LEVEL SECURITY;

-- Workspace members can view submissions
CREATE POLICY "Workspace members can view form submissions"
  ON public.form_submissions FOR SELECT
  USING (
    workspace_id IN (
      SELECT wm.workspace_id FROM public.workspace_members wm
      WHERE wm.user_id = auth.uid()
    )
  );

-- Server-side insert (admin client bypasses RLS for public submissions)
CREATE POLICY "Service role can insert form submissions"
  ON public.form_submissions FOR INSERT
  WITH CHECK (true);

-- Server-side update (admin client for status changes)
CREATE POLICY "Service role can update form submissions"
  ON public.form_submissions FOR UPDATE
  USING (true);

-- Server-side delete (admin client for GDPR deletion)
CREATE POLICY "Service role can delete form submissions"
  ON public.form_submissions FOR DELETE
  USING (true);

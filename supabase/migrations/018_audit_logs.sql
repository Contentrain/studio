-- GDPR audit logging — tracks destructive operations for compliance.
--
-- Two layers:
-- 1. Application-level: Nitro middleware snapshots records before DELETE handlers run,
--    plugin writes audit log after successful response (captures actor, IP, user-agent).
-- 2. Database-level: BEFORE DELETE trigger on form_submissions catches CASCADE deletes
--    that bypass application code (project/workspace/account deletion).

-- ============================================================
-- audit_logs table
-- ============================================================

CREATE TABLE IF NOT EXISTS public.audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID,                          -- nullable: account deletion has no single workspace
  actor_id UUID,                              -- nullable: CASCADE deletes have no actor context
  action TEXT NOT NULL,                        -- e.g. 'delete_form_submission', 'delete_project'
  table_name TEXT NOT NULL,                    -- source table: 'form_submissions', 'projects', etc.
  record_id UUID NOT NULL,                     -- PK of the deleted record
  record_snapshot JSONB,                       -- full row before deletion
  source_ip INET,                             -- request IP (app-level only)
  user_agent TEXT,                            -- request user-agent (app-level only)
  origin TEXT NOT NULL DEFAULT 'app',         -- 'app' = middleware, 'cascade' = DB trigger
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Index for workspace-scoped queries and retention cleanup
CREATE INDEX IF NOT EXISTS idx_audit_logs_workspace ON public.audit_logs (workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_created ON public.audit_logs (created_at);

-- ============================================================
-- BEFORE DELETE trigger on form_submissions
-- Captures CASCADE deletes (project/workspace/account deletion)
-- that bypass application code.
-- ============================================================

CREATE OR REPLACE FUNCTION public.audit_form_submission_delete()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
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
    'delete_form_submission',
    'form_submissions',
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

CREATE TRIGGER trg_audit_form_submission_delete
  BEFORE DELETE ON public.form_submissions
  FOR EACH ROW
  EXECUTE FUNCTION public.audit_form_submission_delete();

-- ============================================================
-- RLS policies — workspace members can view their workspace's audit logs.
-- Admin client writes (service_role), so no INSERT policy needed.
-- ============================================================

ALTER TABLE public.audit_logs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Workspace members can view audit logs"
  ON public.audit_logs FOR SELECT
  USING (
    workspace_id IS NULL  -- account-level deletions visible to none via RLS (admin only)
    OR workspace_id IN (
      SELECT wm.workspace_id FROM public.workspace_members wm
      WHERE wm.user_id = auth.uid()
    )
  );

-- ============================================================
-- Retention cleanup function — call periodically to purge old logs.
-- Default: 90 days. Can be called from a Nitro plugin (setInterval)
-- or external cron.
-- ============================================================

CREATE OR REPLACE FUNCTION public.cleanup_audit_logs(retention_days INTEGER DEFAULT 90)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  deleted_count INTEGER;
BEGIN
  DELETE FROM public.audit_logs
  WHERE created_at < now() - (retention_days || ' days')::INTERVAL;
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END;
$$;

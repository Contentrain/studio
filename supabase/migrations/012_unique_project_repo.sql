-- Prevent duplicate project connections within the same workspace
CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_workspace_repo
  ON public.projects (workspace_id, repo_full_name);

-- Project-level GitHub access tracking.
--
-- Migration 004 added workspace-level installation lifecycle tracking
-- (`github_installation_status` on workspaces). That handles "App
-- suspended / uninstalled" at the workspace boundary, but it does not
-- capture per-repo access changes:
--
--  - User flips an installation from "All repositories" to "Only
--    selected" and the connected repo is no longer in the set
--  - Org admin / second owner removes a single repo from the
--    installation's accessible list
--  - Repo is deleted on GitHub
--  - Repo is renamed on GitHub
--
-- In each case `workspaces.github_installation_id` is still valid and
-- `github_installation_status='active'` is correct — the App itself
-- works, but Studio's connected project for that specific repo will
-- start receiving 404s on commit / branch / scan operations. Without
-- a project-level signal there's no way to tell the user *why*, and
-- no way to lock the project to a "needs reconnect" state.
--
-- `access_status` is independent of the existing `status` column
-- (which tracks setup state: active/setup/error). A project can be
-- `status='active'` AND `access_status='inaccessible'` — the project
-- is otherwise healthy but its underlying repo lost access.

ALTER TABLE public.projects
  ADD COLUMN access_status text NOT NULL DEFAULT 'accessible';

ALTER TABLE public.projects
  ADD CONSTRAINT projects_access_status_check
    CHECK (access_status IN ('accessible', 'inaccessible', 'deleted'));

-- Webhook handlers look up projects by (installation_id from
-- workspaces JOIN, repo_full_name). Repo_full_name is the high-
-- cardinality field used in WHERE; index it directly. The webhook
-- query already filters by workspace's installation_id via JOIN.
CREATE INDEX IF NOT EXISTS idx_projects_repo_full_name
  ON public.projects (repo_full_name);

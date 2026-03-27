-- Partial indexes for efficient pending-invite lookups
-- Used by accept-invite middleware to quickly find unaccepted memberships

create index if not exists idx_workspace_members_pending
  on public.workspace_members (user_id, workspace_id)
  where accepted_at is null;

create index if not exists idx_project_members_pending
  on public.project_members (user_id)
  where accepted_at is null;

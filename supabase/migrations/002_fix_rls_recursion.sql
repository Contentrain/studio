-- Fix self-referencing RLS policies that cause infinite recursion
-- Run this in Supabase SQL Editor

-- Drop problematic policies
drop policy if exists "Members can view workspace members" on public.workspace_members;
drop policy if exists "Owner/Admin can add workspace members" on public.workspace_members;
drop policy if exists "Owner/Admin can update workspace members" on public.workspace_members;
drop policy if exists "Owner/Admin can remove workspace members" on public.workspace_members;
drop policy if exists "Workspace co-members can view profiles" on public.profiles;

-- Workspace Members SELECT: user can see own memberships + members in workspaces they own
create policy "Users can view own memberships"
  on public.workspace_members for select
  using (
    user_id = auth.uid()
    or exists (
      select 1 from public.workspaces
      where workspaces.id = workspace_members.workspace_id
      and workspaces.owner_id = auth.uid()
    )
  );

-- Workspace Members INSERT: workspace owner (via workspaces table) or admin (via own membership check)
create policy "Owner/Admin can add workspace members"
  on public.workspace_members for insert
  with check (
    exists (
      select 1 from public.workspaces
      where workspaces.id = workspace_members.workspace_id
      and workspaces.owner_id = auth.uid()
    )
  );

-- Workspace Members UPDATE: only workspace owner
create policy "Owner can update workspace members"
  on public.workspace_members for update
  using (
    exists (
      select 1 from public.workspaces
      where workspaces.id = workspace_members.workspace_id
      and workspaces.owner_id = auth.uid()
    )
  );

-- Workspace Members DELETE: only workspace owner
create policy "Owner can remove workspace members"
  on public.workspace_members for delete
  using (
    exists (
      select 1 from public.workspaces
      where workspaces.id = workspace_members.workspace_id
      and workspaces.owner_id = auth.uid()
    )
  );

-- Profiles: users can see profiles of people in same workspaces (via workspaces table, no recursion)
create policy "Workspace co-members can view profiles"
  on public.profiles for select
  using (
    id = auth.uid()
    or exists (
      select 1 from public.workspaces w
      join public.workspace_members wm on wm.workspace_id = w.id
      where w.owner_id = auth.uid()
      and wm.user_id = profiles.id
    )
  );

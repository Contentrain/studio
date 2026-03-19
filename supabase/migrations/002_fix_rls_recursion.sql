-- Fix cross-table circular RLS policies that cause infinite recursion.
--
-- Rule: _members SELECT policies are TERMINAL — they only check user_id = auth.uid()
-- and never reference another table. This breaks all possible recursion chains.
--
-- Safe reference chain:
--   workspaces SELECT → reads workspace_members SELECT (terminal) ✓
--   projects SELECT → reads workspace_members SELECT (terminal) + project_members SELECT (terminal) ✓
--   project write policies → reads workspace_members via projects join (terminal) ✓

-- === WORKSPACE MEMBERS ===
drop policy if exists "Members can view workspace members" on public.workspace_members;
drop policy if exists "Users can view own memberships" on public.workspace_members;

create policy "Users can view own memberships"
  on public.workspace_members for select
  using (user_id = auth.uid());

-- === PROJECT MEMBERS ===
drop policy if exists "Can view project members" on public.project_members;
drop policy if exists "Users can view own project memberships" on public.project_members;

create policy "Users can view own project memberships"
  on public.project_members for select
  using (user_id = auth.uid());

-- === PROFILES ===
drop policy if exists "Workspace co-members can view profiles" on public.profiles;

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

-- === PROJECTS (simplify — any workspace member can see projects) ===
drop policy if exists "Workspace members can view projects" on public.projects;

create policy "Workspace members can view projects"
  on public.projects for select
  using (
    exists (
      select 1 from public.workspace_members
      where workspace_members.workspace_id = projects.workspace_id
      and workspace_members.user_id = auth.uid()
    )
    or exists (
      select 1 from public.project_members
      where project_members.project_id = projects.id
      and project_members.user_id = auth.uid()
    )
  );

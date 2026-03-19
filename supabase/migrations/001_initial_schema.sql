-- Contentrain Studio — Phase 1 Schema v2
-- Hierarchy: User → Workspace → Project
-- Two-tier roles: Workspace (owner/admin/member) + Project (editor/reviewer/viewer)

-- ============================================================
-- 1. PROFILES
-- Extends Supabase auth.users with app-specific data
-- ============================================================

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  email text,
  avatar_url text,
  created_at timestamptz default now()
);

-- ============================================================
-- 2. WORKSPACES
-- Billing entity, team boundary. Every user gets a PRIMARY workspace on signup.
-- GitHub App installation lives here (covers all repos in workspace).
-- ============================================================

create table if not exists public.workspaces (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text unique not null,
  type text not null default 'primary' check (type in ('primary', 'secondary')),
  owner_id uuid not null references public.profiles(id) on delete cascade,
  logo_url text,
  github_installation_id bigint,
  plan text not null default 'free' check (plan in ('free', 'pro', 'team', 'enterprise')),
  created_at timestamptz default now()
);

-- ============================================================
-- 3. WORKSPACE MEMBERS
-- Workspace-level roles: owner, admin, member
-- owner/admin → implicit access to all projects
-- member → needs explicit project_members assignment
-- ============================================================

create table if not exists public.workspace_members (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id uuid references public.profiles(id) on delete cascade,
  role text not null check (role in ('owner', 'admin', 'member')),
  invited_email text,
  invited_at timestamptz default now(),
  accepted_at timestamptz,
  unique(workspace_id, user_id)
);

-- ============================================================
-- 4. PROJECTS
-- Connected repositories, belong to a workspace.
-- github_installation_id removed — inherited from workspace.
-- owner_id removed — workspace.owner_id is the owner.
-- ============================================================

create table if not exists public.projects (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  repo_full_name text not null,
  default_branch text not null default 'main',
  content_root text not null default '/',
  detected_stack text,
  status text not null default 'active' check (status in ('active', 'setup', 'error')),
  created_at timestamptz default now()
);

-- ============================================================
-- 5. PROJECT MEMBERS
-- Project-level role override for workspace members.
-- Fixed roles: editor, reviewer, viewer (no custom roles).
-- specificModels pattern: restrict editor to specific models.
-- ============================================================

create table if not exists public.project_members (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  user_id uuid references public.profiles(id) on delete cascade,
  role text not null check (role in ('editor', 'reviewer', 'viewer')),
  specific_models boolean not null default false,
  allowed_models text[] not null default '{}',
  invited_email text,
  invited_at timestamptz default now(),
  accepted_at timestamptz,
  unique(project_id, user_id)
);

-- ============================================================
-- INDEXES
-- ============================================================

create index if not exists idx_workspaces_owner on public.workspaces(owner_id);
create index if not exists idx_workspaces_slug on public.workspaces(slug);
create index if not exists idx_workspace_members_workspace on public.workspace_members(workspace_id);
create index if not exists idx_workspace_members_user on public.workspace_members(user_id);
create index if not exists idx_projects_workspace on public.projects(workspace_id);
create index if not exists idx_project_members_project on public.project_members(project_id);
create index if not exists idx_project_members_user on public.project_members(user_id);

-- ============================================================
-- TRIGGERS & FUNCTIONS
-- ============================================================

-- Auto-create profile + personal workspace on signup
create or replace function public.handle_new_user()
returns trigger as $$
declare
  ws_id uuid;
  ws_slug text;
begin
  -- Create profile
  insert into public.profiles (id, display_name, email, avatar_url)
  values (
    new.id,
    coalesce(
      new.raw_user_meta_data ->> 'full_name',
      new.raw_user_meta_data ->> 'name',
      split_part(new.email, '@', 1)
    ),
    new.email,
    new.raw_user_meta_data ->> 'avatar_url'
  );

  -- Generate unique slug: username/email prefix + short uuid
  ws_slug := lower(regexp_replace(
    coalesce(
      new.raw_user_meta_data ->> 'user_name',
      new.raw_user_meta_data ->> 'preferred_username',
      split_part(new.email, '@', 1)
    ),
    '[^a-z0-9-]', '-', 'g'
  )) || '-' || substr(new.id::text, 1, 8);

  -- Create personal workspace
  ws_id := gen_random_uuid();
  insert into public.workspaces (id, name, slug, type, owner_id)
  values (
    ws_id,
    coalesce(
      new.raw_user_meta_data ->> 'full_name',
      new.raw_user_meta_data ->> 'name',
      split_part(new.email, '@', 1)
    ) || '''s Workspace',
    ws_slug,
    'primary',
    new.id
  );

  return new;
end;
$$ language plpgsql security definer;

create or replace trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Auto-add owner as workspace member when workspace is created
create or replace function public.handle_new_workspace()
returns trigger as $$
begin
  insert into public.workspace_members (workspace_id, user_id, role, accepted_at)
  values (new.id, new.owner_id, 'owner', now());
  return new;
end;
$$ language plpgsql security definer;

create or replace trigger on_workspace_created
  after insert on public.workspaces
  for each row execute function public.handle_new_workspace();

-- ============================================================
-- ROW LEVEL SECURITY
-- ============================================================

alter table public.profiles enable row level security;
alter table public.workspaces enable row level security;
alter table public.workspace_members enable row level security;
alter table public.projects enable row level security;
alter table public.project_members enable row level security;

-- --- PROFILES ---

create policy "Users can view own profile"
  on public.profiles for select
  using (auth.uid() = id);

create policy "Users can update own profile"
  on public.profiles for update
  using (auth.uid() = id);

-- Allow reading profiles of workspace co-members (for member lists)
create policy "Workspace co-members can view profiles"
  on public.profiles for select
  using (
    exists (
      select 1 from public.workspace_members wm1
      join public.workspace_members wm2 on wm1.workspace_id = wm2.workspace_id
      where wm1.user_id = auth.uid()
      and wm2.user_id = profiles.id
    )
  );

-- --- WORKSPACES ---

create policy "Members can view workspaces"
  on public.workspaces for select
  using (
    owner_id = auth.uid()
    or exists (
      select 1 from public.workspace_members
      where workspace_members.workspace_id = workspaces.id
      and workspace_members.user_id = auth.uid()
    )
  );

create policy "Authenticated users can create workspaces"
  on public.workspaces for insert
  with check (auth.uid() = owner_id);

create policy "Owner can update workspace"
  on public.workspaces for update
  using (owner_id = auth.uid());

create policy "Owner can delete workspace"
  on public.workspaces for delete
  using (owner_id = auth.uid());

-- --- WORKSPACE MEMBERS ---

create policy "Members can view workspace members"
  on public.workspace_members for select
  using (
    exists (
      select 1 from public.workspace_members as wm
      where wm.workspace_id = workspace_members.workspace_id
      and wm.user_id = auth.uid()
    )
  );

-- Owner/Admin can add workspace members
-- Also allows workspace owner (via workspaces table) for bootstrapping
create policy "Owner/Admin can add workspace members"
  on public.workspace_members for insert
  with check (
    exists (
      select 1 from public.workspace_members as wm
      where wm.workspace_id = workspace_members.workspace_id
      and wm.user_id = auth.uid()
      and wm.role in ('owner', 'admin')
    )
    or exists (
      select 1 from public.workspaces
      where workspaces.id = workspace_members.workspace_id
      and workspaces.owner_id = auth.uid()
    )
  );

create policy "Owner/Admin can update workspace members"
  on public.workspace_members for update
  using (
    exists (
      select 1 from public.workspace_members as wm
      where wm.workspace_id = workspace_members.workspace_id
      and wm.user_id = auth.uid()
      and wm.role in ('owner', 'admin')
    )
  );

create policy "Owner/Admin can remove workspace members"
  on public.workspace_members for delete
  using (
    exists (
      select 1 from public.workspace_members as wm
      where wm.workspace_id = workspace_members.workspace_id
      and wm.user_id = auth.uid()
      and wm.role in ('owner', 'admin')
    )
  );

-- --- PROJECTS ---

-- Workspace owner/admin sees all projects; members see assigned projects
create policy "Workspace members can view projects"
  on public.projects for select
  using (
    exists (
      select 1 from public.workspace_members
      where workspace_members.workspace_id = projects.workspace_id
      and workspace_members.user_id = auth.uid()
      and workspace_members.role in ('owner', 'admin')
    )
    or exists (
      select 1 from public.project_members
      where project_members.project_id = projects.id
      and project_members.user_id = auth.uid()
    )
  );

-- Only workspace owner/admin can create projects
create policy "Owner/Admin can create projects"
  on public.projects for insert
  with check (
    exists (
      select 1 from public.workspace_members
      where workspace_members.workspace_id = projects.workspace_id
      and workspace_members.user_id = auth.uid()
      and workspace_members.role in ('owner', 'admin')
    )
  );

create policy "Owner/Admin can update projects"
  on public.projects for update
  using (
    exists (
      select 1 from public.workspace_members
      where workspace_members.workspace_id = projects.workspace_id
      and workspace_members.user_id = auth.uid()
      and workspace_members.role in ('owner', 'admin')
    )
  );

create policy "Owner/Admin can delete projects"
  on public.projects for delete
  using (
    exists (
      select 1 from public.workspace_members
      where workspace_members.workspace_id = projects.workspace_id
      and workspace_members.user_id = auth.uid()
      and workspace_members.role in ('owner', 'admin')
    )
  );

-- --- PROJECT MEMBERS ---

-- Visible to workspace owner/admin or project members
create policy "Can view project members"
  on public.project_members for select
  using (
    exists (
      select 1 from public.projects p
      join public.workspace_members wm on wm.workspace_id = p.workspace_id
      where p.id = project_members.project_id
      and wm.user_id = auth.uid()
      and wm.role in ('owner', 'admin')
    )
    or exists (
      select 1 from public.project_members as pm
      where pm.project_id = project_members.project_id
      and pm.user_id = auth.uid()
    )
  );

-- Only workspace owner/admin can manage project members
create policy "Owner/Admin can add project members"
  on public.project_members for insert
  with check (
    exists (
      select 1 from public.projects p
      join public.workspace_members wm on wm.workspace_id = p.workspace_id
      where p.id = project_members.project_id
      and wm.user_id = auth.uid()
      and wm.role in ('owner', 'admin')
    )
  );

create policy "Owner/Admin can update project members"
  on public.project_members for update
  using (
    exists (
      select 1 from public.projects p
      join public.workspace_members wm on wm.workspace_id = p.workspace_id
      where p.id = project_members.project_id
      and wm.user_id = auth.uid()
      and wm.role in ('owner', 'admin')
    )
  );

create policy "Owner/Admin can remove project members"
  on public.project_members for delete
  using (
    exists (
      select 1 from public.projects p
      join public.workspace_members wm on wm.workspace_id = p.workspace_id
      where p.id = project_members.project_id
      and wm.user_id = auth.uid()
      and wm.role in ('owner', 'admin')
    )
  );

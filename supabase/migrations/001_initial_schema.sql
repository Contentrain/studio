-- Contentrain Studio — Phase 1 Schema
-- Profiles: extends Supabase auth.users with app-specific data

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  github_id bigint,
  github_login text,
  avatar_url text,
  created_at timestamptz default now()
);

-- Auto-create profile on signup
create or replace function public.handle_new_user()
returns trigger as $$
begin
  insert into public.profiles (id, avatar_url)
  values (
    new.id,
    new.raw_user_meta_data ->> 'avatar_url'
  );
  return new;
end;
$$ language plpgsql security definer;

create or replace trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Projects
create table if not exists public.projects (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.profiles(id) on delete cascade,
  provider text not null default 'github',
  repo_full_name text not null,
  default_branch text not null default 'main',
  content_root text not null default '/',
  detected_stack text,
  github_installation_id bigint,
  status text not null default 'active' check (status in ('active', 'setup', 'error')),
  created_at timestamptz default now()
);

-- Project members with role-based access
create table if not exists public.project_members (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  user_id uuid references public.profiles(id) on delete cascade,
  role text not null check (role in ('owner', 'editor', 'reviewer', 'viewer')),
  specific_models boolean not null default false,
  allowed_models text[] not null default '{}',
  invited_email text,
  invited_at timestamptz default now(),
  accepted_at timestamptz,
  unique(project_id, user_id)
);

-- Indexes
create index if not exists idx_projects_owner on public.projects(owner_id);
create index if not exists idx_project_members_project on public.project_members(project_id);
create index if not exists idx_project_members_user on public.project_members(user_id);
create index if not exists idx_project_members_email on public.project_members(invited_email);

-- Row Level Security
alter table public.profiles enable row level security;
alter table public.projects enable row level security;
alter table public.project_members enable row level security;

-- Profiles: users can read/update their own profile
create policy "Users can view own profile"
  on public.profiles for select
  using (auth.uid() = id);

create policy "Users can update own profile"
  on public.profiles for update
  using (auth.uid() = id);

-- Projects: users can see projects they are members of
create policy "Members can view projects"
  on public.projects for select
  using (
    owner_id = auth.uid()
    or exists (
      select 1 from public.project_members
      where project_members.project_id = projects.id
      and project_members.user_id = auth.uid()
    )
  );

-- Projects: only authenticated users can create
create policy "Authenticated users can create projects"
  on public.projects for insert
  with check (auth.uid() = owner_id);

-- Projects: only owner can update/delete
create policy "Owner can update project"
  on public.projects for update
  using (owner_id = auth.uid());

create policy "Owner can delete project"
  on public.projects for delete
  using (owner_id = auth.uid());

-- Project members: visible to project members
create policy "Members can view project members"
  on public.project_members for select
  using (
    exists (
      select 1 from public.project_members as pm
      where pm.project_id = project_members.project_id
      and pm.user_id = auth.uid()
    )
  );

-- Project members: only owner can manage
create policy "Owner can manage members"
  on public.project_members for insert
  with check (
    exists (
      select 1 from public.projects
      where projects.id = project_members.project_id
      and projects.owner_id = auth.uid()
    )
  );

create policy "Owner can update members"
  on public.project_members for update
  using (
    exists (
      select 1 from public.projects
      where projects.id = project_members.project_id
      and projects.owner_id = auth.uid()
    )
  );

create policy "Owner can remove members"
  on public.project_members for delete
  using (
    exists (
      select 1 from public.projects
      where projects.id = project_members.project_id
      and projects.owner_id = auth.uid()
    )
  );

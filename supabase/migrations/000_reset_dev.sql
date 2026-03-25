-- DEV ONLY — Drop all app-owned objects so later migrations can rebuild cleanly.
-- This file must stay safe on an empty database because local Supabase applies
-- migrations from scratch during `supabase start`.

-- Drop triggers first
drop trigger if exists on_auth_user_created on auth.users;

-- Drop functions
drop function if exists public.handle_new_user();
drop function if exists public.handle_new_workspace();

-- Drop tables (order matters for FK constraints)
drop table if exists public.media_usage cascade;
drop table if exists public.media_assets cascade;
drop table if exists public.cdn_usage cascade;
drop table if exists public.cdn_builds cascade;
drop table if exists public.cdn_api_keys cascade;
drop table if exists public.messages cascade;
drop table if exists public.conversations cascade;
drop table if exists public.agent_usage cascade;
drop table if exists public.ai_keys cascade;
drop table if exists public.project_members cascade;
drop table if exists public.projects cascade;
drop table if exists public.workspace_members cascade;
drop table if exists public.workspaces cascade;
drop table if exists public.profiles cascade;

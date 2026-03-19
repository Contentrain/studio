-- DEV ONLY — Drop all tables and recreate from scratch
-- Run this in Supabase SQL Editor BEFORE applying 001_initial_schema.sql

-- Drop triggers first
drop trigger if exists on_auth_user_created on auth.users;

-- Drop functions
drop function if exists public.handle_new_user();

-- Drop policies
drop policy if exists "Users can view own profile" on public.profiles;
drop policy if exists "Users can update own profile" on public.profiles;
drop policy if exists "Members can view projects" on public.projects;
drop policy if exists "Authenticated users can create projects" on public.projects;
drop policy if exists "Owner can update project" on public.projects;
drop policy if exists "Owner can delete project" on public.projects;
drop policy if exists "Members can view project members" on public.project_members;
drop policy if exists "Owner can manage members" on public.project_members;
drop policy if exists "Owner can update members" on public.project_members;
drop policy if exists "Owner can remove members" on public.project_members;

-- Drop tables (order matters for FK constraints)
drop table if exists public.project_members cascade;
drop table if exists public.projects cascade;
drop table if exists public.profiles cascade;

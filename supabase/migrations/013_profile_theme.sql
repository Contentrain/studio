-- Add theme preference to profiles (server-persisted)
alter table public.profiles
  add column if not exists theme text not null default 'system'
  check (theme in ('light', 'dark', 'system'));

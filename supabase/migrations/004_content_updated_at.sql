-- Add content_updated_at to track GitHub webhook push events
alter table public.projects add column if not exists content_updated_at timestamptz;

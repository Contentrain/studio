-- 047: workspace slugs Migrate (and every other consumer) can use.
--
-- handle_new_user() replaced [^a-z0-9-] with "-" BEFORE lowercasing, so a GitHub name with capitals ("ABB65") became
-- "---65-1a2b3c4d": a slug that starts with a hyphen. @contentrain/types validates the workspace slug Studio answers
-- Migrate with (^[a-z0-9][a-z0-9-]{0,62}$), so POST /api/migrate/provision refused such an account with a 502.
--
-- 1. The trigger lowercases first, collapses runs of other characters to one hyphen, trims hyphens, and falls back to "user".
-- 2. Repair: only workspaces whose slug fails the pattern are rewritten (same normalisation); a valid slug is never touched.
--    A rewritten slug that collides with another gets the workspace id's first 8 characters (then a counter) appended.
--    Nothing else stores a slug: grants, billing, CDN, MCP and CLI use workspace ids. What does change is the address
--    of that one workspace (/w/<slug>) and any link to it already sent by email.
-- Re-running is a no-op: after the first run every slug matches.

CREATE OR REPLACE FUNCTION public.handle_new_user() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE
  ws_id uuid;
  ws_slug text;
BEGIN
  INSERT INTO public.profiles (id, display_name, email, avatar_url)
  VALUES (
    new.id,
    coalesce(
      new.raw_user_meta_data ->> 'full_name',
      new.raw_user_meta_data ->> 'name',
      split_part(new.email, '@', 1)
    ),
    new.email,
    new.raw_user_meta_data ->> 'avatar_url'
  );

  -- Lowercase BEFORE replacing: replacing first turned every capital of "ABB65" into "-" and left a slug that starts
  -- with a hyphen. Runs of anything else collapse to one hyphen; an empty result falls back to "user".
  ws_slug := coalesce(nullif(trim(BOTH '-' FROM regexp_replace(lower(
    coalesce(
      new.raw_user_meta_data ->> 'user_name',
      new.raw_user_meta_data ->> 'preferred_username',
      split_part(new.email, '@', 1)
    )
  ), '[^a-z0-9]+', '-', 'g')), ''), 'user');
  ws_slug := trim(BOTH '-' FROM left(ws_slug, 40)) || '-' || substr(new.id::text, 1, 8);

  ws_id := gen_random_uuid();
  INSERT INTO public.workspaces (id, name, slug, type, owner_id, plan)
  VALUES (
    ws_id,
    coalesce(
      new.raw_user_meta_data ->> 'full_name',
      new.raw_user_meta_data ->> 'name',
      split_part(new.email, '@', 1)
    ) || '''s Workspace',
    ws_slug,
    'primary',
    new.id,
    'free'
  );

  RETURN new;
END;
$$;

DO $repair$
DECLARE
  w record;
  base text;
  candidate text;
  n integer;
BEGIN
  FOR w IN
    SELECT id, slug FROM public.workspaces WHERE slug !~ '^[a-z0-9][a-z0-9-]{0,62}$' ORDER BY id
  LOOP
    base := coalesce(nullif(trim(BOTH '-' FROM regexp_replace(lower(w.slug), '[^a-z0-9]+', '-', 'g')), ''), 'workspace');
    base := coalesce(nullif(trim(BOTH '-' FROM left(base, 54)), ''), 'workspace');
    candidate := base;
    IF EXISTS (SELECT 1 FROM public.workspaces WHERE slug = candidate AND id <> w.id) THEN
      candidate := base || '-' || substr(w.id::text, 1, 8);
      n := 1;
      WHILE EXISTS (SELECT 1 FROM public.workspaces WHERE slug = candidate AND id <> w.id) LOOP
        n := n + 1;
        candidate := base || '-' || substr(w.id::text, 1, 8) || '-' || n;
      END LOOP;
    END IF;
    UPDATE public.workspaces SET slug = candidate WHERE id = w.id;
  END LOOP;
END
$repair$;

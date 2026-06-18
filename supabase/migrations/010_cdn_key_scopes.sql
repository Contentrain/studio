-- CDN API key scopes
--
-- Adds scope-based permissions to `cdn_api_keys` so the same Bearer-key
-- system gates the media management API (read/write) separately from CDN
-- delivery. Scopes are an array so one key can hold any subset:
--   'delivery'    — serve assets via /api/cdn/v1/... (existing behaviour)
--   'media:read'  — list/get assets via /api/media/v1/...
--   'media:write' — upload/update/delete assets via /api/media/v1/...
--
-- Existing keys default to {delivery}, so CDN serving keeps working
-- untouched and no key gains media access implicitly.

ALTER TABLE public.cdn_api_keys
  ADD COLUMN scopes text[] NOT NULL DEFAULT ARRAY['delivery']::text[];

-- Recreate the atomic key-creation RPC with a `p_scopes` parameter so keys
-- can be minted with explicit scopes. Dropping the old 6-arg signature
-- avoids an ambiguous overload; the new arg defaults to {delivery} so the
-- existing named-argument call site (which omits it) is unaffected.
DROP FUNCTION IF EXISTS public.create_cdn_key_if_allowed(uuid, uuid, text, character varying, text, integer);

CREATE FUNCTION public.create_cdn_key_if_allowed(
  p_project_id uuid,
  p_workspace_id uuid,
  p_key_hash text,
  p_key_prefix character varying,
  p_name text,
  p_limit integer DEFAULT 0,
  p_scopes text[] DEFAULT ARRAY['delivery']::text[]
) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE
  v_count INTEGER;
  v_key public.cdn_api_keys;
BEGIN
  -- Serialize concurrent key creation for same project
  PERFORM pg_advisory_xact_lock(
    hashtext('cdn:' || p_project_id::text)
  );

  -- Count active (non-revoked) keys
  SELECT COUNT(*) INTO v_count
  FROM public.cdn_api_keys
  WHERE project_id = p_project_id
    AND revoked_at IS NULL;

  -- Reject if at or over limit
  IF v_count >= p_limit THEN
    RETURN jsonb_build_object('allowed', false, 'current_count', v_count);
  END IF;

  -- Insert the new key
  INSERT INTO public.cdn_api_keys (
    project_id, workspace_id, key_hash, key_prefix, name, scopes
  )
  VALUES (
    p_project_id, p_workspace_id, p_key_hash, p_key_prefix, p_name, p_scopes
  )
  RETURNING * INTO v_key;

  RETURN jsonb_build_object(
    'allowed', true,
    'current_count', v_count + 1,
    'key', jsonb_build_object(
      'id', v_key.id,
      'name', v_key.name,
      'key_prefix', v_key.key_prefix,
      'environment', v_key.environment,
      'scopes', v_key.scopes,
      'created_at', v_key.created_at
    )
  );
END;
$$;

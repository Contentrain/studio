-- Conversation API actor model + dedicated API usage table.
--
-- Two related concerns ship together because either alone leaves the
-- Conversation API endpoint broken at the next DB call:
--
-- 1. API message billing
--    The Conversation API actor is an API key, not a user. Earlier
--    code routed through `agent_usage` with `source='api'`, which
--    violates both `agent_usage_source_check` (only allows
--    'studio'|'byoa') and `agent_usage_user_id_fkey` (FK → profiles).
--    Squeezing API usage into the per-user `agent_usage` model with
--    nullable user_id + COALESCE-UNIQUE was rejected during review —
--    actor types are too different (lifecycle, scope, permissions).
--
--    A dedicated `api_message_usage` table aggregates per
--    `(workspace, api_key, month)` with both message_count and token
--    counts, mirroring `agent_usage`'s aggregate shape but keyed by
--    API key. The same pattern is expected for MCP Cloud keys later.
--
-- 2. Conversation ownership
--    `conversations.user_id` is `NOT NULL REFERENCES profiles(id)`,
--    so a Conversation-API-initiated chat would fail FK on
--    createConversation even after the usage fix. This migration
--    relaxes the column, adds nullable `api_key_id` FK, and enforces
--    an XOR check so every row has exactly one actor. Existing rows
--    all carry user_id and trivially satisfy the new check.
--
-- RLS is unaffected for the user path — `user_id = auth.uid()`
-- evaluates to NULL (= "not visible") for API-owned rows, which is
-- the correct behavior since API-owned conversations are only
-- accessed via the service-role admin client.

-- ─────────────────────────────────────────────────────────────────
-- 1. api_message_usage table
-- ─────────────────────────────────────────────────────────────────

CREATE TABLE public.api_message_usage (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  api_key_id uuid NOT NULL REFERENCES public.conversation_api_keys(id) ON DELETE CASCADE,
  month text NOT NULL,
  message_count integer NOT NULL DEFAULT 0,
  input_tokens bigint NOT NULL DEFAULT 0,
  output_tokens bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, api_key_id, month)
);

CREATE INDEX idx_api_message_usage_workspace_month
  ON public.api_message_usage (workspace_id, month);

ALTER TABLE public.api_message_usage ENABLE ROW LEVEL SECURITY;

-- Workspace owners and admins can read API usage for their workspaces;
-- mirrors the conversation_api_keys read policy so the billing UI can
-- render per-key usage without exposing cross-workspace rows.
CREATE POLICY "Workspace admins view API usage" ON public.api_message_usage
  FOR SELECT USING (
    workspace_id IN (
      SELECT wm.workspace_id FROM public.workspace_members wm
      WHERE wm.user_id = auth.uid()
        AND wm.role IN ('owner', 'admin')
    )
  );

-- All writes go through SECURITY DEFINER RPCs called from the service
-- role; no INSERT/UPDATE policy is granted to authenticated users.

-- ─────────────────────────────────────────────────────────────────
-- 2. Atomic reserve: two-cap (per-key + per-workspace) message limit
-- ─────────────────────────────────────────────────────────────────

CREATE FUNCTION public.increment_api_usage_if_allowed(
  p_workspace_id uuid,
  p_api_key_id uuid,
  p_month text,
  p_key_limit integer,
  p_workspace_limit integer
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
  v_key_current INTEGER;
  v_workspace_current INTEGER;
BEGIN
  -- Serialize concurrent reservations for the same key/month so two
  -- racing requests can't both pass the cap check.
  PERFORM pg_advisory_xact_lock(
    hashtext(p_workspace_id::text || ':' || p_api_key_id::text || ':' || p_month)
  );

  -- Per-key current count
  SELECT COALESCE(message_count, 0) INTO v_key_current
  FROM public.api_message_usage
  WHERE workspace_id = p_workspace_id
    AND api_key_id = p_api_key_id
    AND month = p_month;

  IF v_key_current IS NULL THEN
    v_key_current := 0;
  END IF;

  IF v_key_current >= p_key_limit THEN
    RETURN jsonb_build_object(
      'allowed', false,
      'reason', 'key_limit',
      'current', v_key_current
    );
  END IF;

  -- Workspace total across every API key in this workspace+month
  SELECT COALESCE(SUM(message_count), 0) INTO v_workspace_current
  FROM public.api_message_usage
  WHERE workspace_id = p_workspace_id
    AND month = p_month;

  IF v_workspace_current >= p_workspace_limit THEN
    RETURN jsonb_build_object(
      'allowed', false,
      'reason', 'workspace_limit',
      'current', v_workspace_current
    );
  END IF;

  -- Reserve: atomic upsert +1 message
  INSERT INTO public.api_message_usage (
    workspace_id, api_key_id, month, message_count, input_tokens, output_tokens
  )
  VALUES (
    p_workspace_id, p_api_key_id, p_month, 1, 0, 0
  )
  ON CONFLICT (workspace_id, api_key_id, month) DO UPDATE SET
    message_count = public.api_message_usage.message_count + 1,
    updated_at = now();

  RETURN jsonb_build_object(
    'allowed', true,
    'reason', 'ok',
    'current', v_key_current + 1
  );
END;
$$;

-- ─────────────────────────────────────────────────────────────────
-- 3. Token accounting (after AI call completes)
-- ─────────────────────────────────────────────────────────────────

CREATE FUNCTION public.increment_api_usage_tokens(
  p_workspace_id uuid,
  p_api_key_id uuid,
  p_month text,
  p_input_tokens bigint,
  p_output_tokens bigint
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO ''
AS $$
BEGIN
  UPDATE public.api_message_usage
  SET
    input_tokens = input_tokens + p_input_tokens,
    output_tokens = output_tokens + p_output_tokens,
    updated_at = now()
  WHERE workspace_id = p_workspace_id
    AND api_key_id = p_api_key_id
    AND month = p_month;
END;
$$;

-- ─────────────────────────────────────────────────────────────────
-- 4. conversations actor relaxation
-- ─────────────────────────────────────────────────────────────────

ALTER TABLE public.conversations
  ALTER COLUMN user_id DROP NOT NULL;

ALTER TABLE public.conversations
  ADD COLUMN api_key_id uuid REFERENCES public.conversation_api_keys(id) ON DELETE CASCADE;

ALTER TABLE public.conversations
  ADD CONSTRAINT conversations_actor_xor
    CHECK (num_nonnulls(user_id, api_key_id) = 1);

CREATE INDEX idx_conversations_api_key
  ON public.conversations (api_key_id)
  WHERE api_key_id IS NOT NULL;

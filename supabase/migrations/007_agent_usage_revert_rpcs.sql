-- Revert RPCs for atomic message-slot reservations.
--
-- Both `incrementAgentUsageIfAllowed` (studio chat) and
-- `incrementAPIUsageIfAllowed` (Conversation API) reserve a message
-- slot BEFORE the LLM call so concurrent requests can't double-spend
-- the last slot under the plan limit. The previous design treated
-- every reservation as terminal: a slot consumed before the AI call
-- (DB error, brain-cache failure, Anthropic auth failure, client
-- abort before first token) stayed consumed and counted toward the
-- monthly limit even though no LLM work was done.
--
-- The runtime billing rule is: a message becomes billable the moment
-- Anthropic streams its first `text` or `tool_use` event. Any failure
-- before that point triggers a revert via these RPCs. Once committed,
-- failures (provider error mid-stream, save failure, etc.) stay
-- billable — we paid for whatever tokens we received.
--
-- `GREATEST(message_count - 1, 0)` clamps the count at zero so a
-- double-revert race (caller's finally + caller's outer catch both
-- firing through best-effort wrappers) can never push the counter
-- negative.

CREATE FUNCTION public.decrement_agent_usage(
  p_workspace_id uuid,
  p_user_id uuid,
  p_month text,
  p_source text
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO ''
AS $$
BEGIN
  UPDATE public.agent_usage
  SET message_count = GREATEST(message_count - 1, 0),
      updated_at = now()
  WHERE workspace_id = p_workspace_id
    AND user_id = p_user_id
    AND month = p_month
    AND source = p_source
    AND message_count > 0;
END;
$$;

CREATE FUNCTION public.decrement_api_usage(
  p_workspace_id uuid,
  p_api_key_id uuid,
  p_month text
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO ''
AS $$
BEGIN
  UPDATE public.api_message_usage
  SET message_count = GREATEST(message_count - 1, 0),
      updated_at = now()
  WHERE workspace_id = p_workspace_id
    AND api_key_id = p_api_key_id
    AND month = p_month
    AND message_count > 0;
END;
$$;

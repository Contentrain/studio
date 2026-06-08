-- Durable internal tool-trace persistence for chat conversations.
--
-- Before this migration, `messages` stored exactly two rows per chat
-- POST: one user row (the prompt) and one assistant row (the final
-- iteration's collapsed text + the final iteration's `tool_calls`
-- jsonb). Multi-iteration tool loops lost intermediate assistant
-- narration entirely, and tool_result blocks were never persisted —
-- the engine streamed them to Anthropic, then dropped them on the
-- floor. Resume reads couldn't reconstruct the actual Anthropic
-- protocol shape Claude saw on the prior turn.
--
-- This migration restructures `messages` so a single chat POST writes
-- a deterministic trace:
--
--   seed user row                 internal=false, iteration=NULL, turn_sequence=0
--   assistant iteration 1         internal=true,  iteration=1,    turn_sequence=1
--   tool_result iteration 1       internal=true,  iteration=1,    turn_sequence=2
--   assistant iteration 2         internal=true,  iteration=2,    turn_sequence=3
--   tool_result iteration 2       internal=true,  iteration=2,    turn_sequence=4
--   final assistant               internal=false, iteration=N,    turn_sequence=K
--
-- All rows in the trace share a single `turn_id` (UUID generated
-- once per POST in `saveChatResult`). `turn_sequence` makes ordering
-- deterministic even when a batch INSERT lands every row at the same
-- `created_at` timestamp.
--
-- `internal=true` keeps intermediate trace out of the user-facing
-- transcript. The RLS policy below enforces this at the database
-- layer — a Supabase user client (or a buggy app route that forgets
-- to pass `includeInternal: false`) physically cannot read those
-- rows. Server-side service-role queries bypass RLS and load the
-- full trace for resume.
--
-- Schema choices revisited during review:
--   - `iteration` alone was insufficient: it resets per POST so we
--     can't group cross-conversation. `turn_id` is the actual group
--     key, `iteration` is now a per-turn sequence number used for
--     debug/inspection.
--   - No `block_kind` column. The discriminator lives inside the
--     `content_blocks` jsonb (`type: 'text'|'tool_use'|'tool_result'`)
--     and any indexing need can be served by partial expression
--     indexes later — premature without a real query pattern.
--   - Legacy rows (zero in pre-launch) get `turn_id` defaults from
--     `gen_random_uuid()` — each old row becomes its own turn of one.
--     For pre-launch data that's a non-issue; if this migration ever
--     ran against historical data, the worst case is each historical
--     row standing alone in budget grouping, which still preserves
--     Anthropic protocol shape per-turn.

-- ─────────────────────────────────────────────────────────────────
-- 1. Columns
-- ─────────────────────────────────────────────────────────────────

ALTER TABLE public.messages
  ADD COLUMN content_blocks jsonb NULL,
  ADD COLUMN turn_id uuid NOT NULL DEFAULT gen_random_uuid(),
  ADD COLUMN turn_sequence smallint NOT NULL DEFAULT 0,
  ADD COLUMN iteration smallint NULL,
  ADD COLUMN internal boolean NOT NULL DEFAULT false;

-- Resume reads always order by created_at then turn_sequence so a
-- batch INSERT with identical clock_ticks stays deterministic.
CREATE INDEX idx_messages_conversation_turn
  ON public.messages (conversation_id, created_at, turn_sequence);

-- Public transcript queries always filter `internal = false`; a
-- partial index keeps that hot path narrow even as the trace table
-- grows with internal rows.
CREATE INDEX idx_messages_conversation_visible
  ON public.messages (conversation_id, created_at)
  WHERE internal = false;

-- ─────────────────────────────────────────────────────────────────
-- 2. RLS — hide internal trace from end-user SELECT/INSERT
-- ─────────────────────────────────────────────────────────────────
--
-- Route-level `includeInternal: false` filters protect app code, but
-- a direct Supabase user client query (or a future bug forgetting to
-- pass the flag) would still leak trace rows. Push the boundary into
-- RLS so service-role writes and reads are the ONLY way internal
-- rows are touched.

DROP POLICY IF EXISTS "Users can view own messages" ON public.messages;
DROP POLICY IF EXISTS "Users can insert own messages" ON public.messages;

CREATE POLICY "Users can view own visible messages" ON public.messages
  FOR SELECT
  USING (
    internal = false
    AND EXISTS (
      SELECT 1 FROM public.conversations c
      WHERE c.id = messages.conversation_id
        AND c.user_id = auth.uid()
    )
  );

-- Users may only create non-internal rows directly. Internal trace
-- writes go through the SECURITY DEFINER service-role path used by
-- `insertMessages` in the chat handlers.
CREATE POLICY "Users can insert own visible messages" ON public.messages
  FOR INSERT
  WITH CHECK (
    internal = false
    AND EXISTS (
      SELECT 1 FROM public.conversations c
      WHERE c.id = messages.conversation_id
        AND c.user_id = auth.uid()
    )
  );

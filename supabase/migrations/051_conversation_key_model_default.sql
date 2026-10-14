-- 051: the Conversation API key model default follows the 5.5 catalog.
--
-- The baseline (001) left `conversation_api_keys.ai_model` defaulting to
-- 'claude-sonnet-4-5', a model the catalog retired long ago. Studio always
-- writes the column on create, so the default only reaches a row inserted
-- by hand; it now names the current default model (`DEFAULT_CHAT_MODEL`,
-- `shared/utils/ai-models.ts`).
--
-- Existing rows are not rewritten. A stored retired ID resolves at read time
-- to its family's current model (`resolveConversationModel`,
-- `server/utils/conversation-keys.ts`), so no key fails at the provider.
-- Re-running is a no-op.

ALTER TABLE public.conversation_api_keys
  ALTER COLUMN ai_model SET DEFAULT 'claude-sonnet-5-5'::text;

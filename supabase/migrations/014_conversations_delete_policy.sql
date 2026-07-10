-- Users could never actually delete their conversations: `conversations`
-- carries INSERT / SELECT / UPDATE policies but no DELETE policy, so the
-- RLS-scoped delete behind DELETE /api/workspaces/:id/projects/:id/
-- conversations/:id (ChatPanel → useChat.deleteConversation) silently
-- affected 0 rows — on every backend, since PostgREST reports a policy-
-- filtered delete as success.
--
-- Surfaced by the postgres DatabaseProvider contract suite, which runs the
-- same RLS-scoped operations against plain Postgres and asserted the
-- intended behavior instead of the latent no-op.

CREATE POLICY "Users can delete own conversations" ON public.conversations
  FOR DELETE USING ((user_id = auth.uid()));

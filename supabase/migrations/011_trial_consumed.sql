-- 011_trial_consumed.sql
-- Track whether a workspace has ever consumed its free trial so the trial
-- can be granted exactly once.
--
-- Neither existing signal is reliable for "has this workspace trialed":
--   * payment_accounts rows are archived (is_active=false) on cancel, so
--     the active row disappears and billing state falls back to 'free' —
--     indistinguishable from a never-trialed workspace.
--   * trial_ends_at on the active row is cleared on the trial→active and
--     trial→canceled transitions.
-- This workspace-level marker is set once by the billing webhook on the
-- first 'trialing' observation and never cleared.

ALTER TABLE public.workspaces
  ADD COLUMN IF NOT EXISTS trial_consumed_at timestamptz;

COMMENT ON COLUMN public.workspaces.trial_consumed_at IS
  'When the workspace first started a free trial. Set once; gates re-trial at checkout (a returning customer gets a paid checkout with no new trial).';

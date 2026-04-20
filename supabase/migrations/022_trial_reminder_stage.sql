-- Trial ending reminder stage
--
-- Tracks how far through the T-3 / T-1 / T-0 reminder sequence a trialing
-- workspace has progressed. Monotonic integer keeps the state machine
-- simple and the cron idempotent:
--
--   0 — no reminder sent (default)
--   1 — T-3 email sent (~3 days before trial_ends_at)
--   2 — T-1 email sent (~1 day before)
--   3 — T-0 email sent (day of / just after trial_ends_at)
--
-- When a workspace upgrades mid-trial (subscription_status transitions
-- away from `trialing`), the billing webhook resets this to 0 so the
-- next trial — if any — starts with a clean slate.

ALTER TABLE public.workspaces
  ADD COLUMN IF NOT EXISTS trial_reminder_stage INTEGER NOT NULL DEFAULT 0;

-- Partial index scoped to the only rows the cron queries.
CREATE INDEX IF NOT EXISTS idx_workspaces_trial_reminder
  ON public.workspaces(trial_ends_at, trial_reminder_stage)
  WHERE trial_ends_at IS NOT NULL AND subscription_status = 'trialing';

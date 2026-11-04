-- 056: the year-end cursor of a prepaid Studio year (055).
--
-- A 6-hour sweep tells the owner before the prepaid year ends (T-30, T-7) and when it
-- has ended with nothing to keep it. `prepaid_reminder_stage` is the sweep's monotonic
-- cursor on the grant, so each mail goes once per year:
--   0  nothing sent    1  T-30 sent    2  T-7 sent    3  the year ended (mail sent, plan ended)
-- It lives on the grant, not beside `trial_reminder_stage` on the workspace: that one is a
-- real trial's cursor, and a revoke resets it.
--
-- Additive: one defaulted column, nothing backfilled; code before this migration never reads it.

ALTER TABLE public.migrate_grants
  ADD COLUMN prepaid_reminder_stage smallint NOT NULL DEFAULT 0
    CHECK (prepaid_reminder_stage BETWEEN 0 AND 3);

-- The sweep looks up live prepaid years by their end.
CREATE INDEX migrate_grants_prepaid_ends_idx
  ON public.migrate_grants (prepaid_ends_at)
  WHERE prepaid_ends_at IS NOT NULL AND revoked_at IS NULL;

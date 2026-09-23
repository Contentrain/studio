-- 034: a third usage-alert level (120 %) for CDN delivery.
--
-- CDN origin transfer is enforced at delivery with a buffer: past the plan
-- limit it keeps serving (the 100 % alert says so), and at 120 % it stops
-- until the month resets (`shared/utils/cdn-limit.ts`). That stop is its own
-- alert, sent once per workspace and month like the other two levels.

ALTER TABLE public.usage_alerts DROP CONSTRAINT IF EXISTS usage_alerts_threshold_check;
ALTER TABLE public.usage_alerts
  ADD CONSTRAINT usage_alerts_threshold_check CHECK (threshold IN (80, 100, 120));

-- 055: a Migrate with Studio bundle collected by Migrate (prepaid Studio year).
--
-- Migrate can now take the whole bundle in one payment of its own (`billing.collector:
-- 'migrate'` on the v2 claim, `@contentrain/types`). Studio then opens no checkout:
-- provision reserves the grant, and Migrate's `grants/activate` call reports the paid
-- transaction. The Studio year is prepaid from that payment, with no subscription
-- behind it and nothing that renews by itself.
--
-- migrate_grants (the source and its history, one per order):
--   collector                who takes the payment: `studio_polar` (Studio's own checkout,
--                            every grant before this) or `migrate`
--   payment_ref              the collector's transaction id once paid; a second transaction
--                            for the order never replaces it
--   prepaid_starts_at/_ends_at  the prepaid year: from the payment, 365 days
--   renewal_subscription_id  the subscription the customer opened to keep Studio after the
--                            year (set later, by the renewal path)
--
-- workspaces (what billing reads on every request, kept beside the plan):
--   prepaid_until / prepaid_plan  the live prepaid year of the workspace, if any. The billing
--                            state is `prepaid` while `prepaid_until` is ahead; the plan comes
--                            from `prepaid_plan`, never from `plan` (a subscription webhook
--                            rewrites that one).
--
-- Additive: every new column is nullable or defaulted, nothing is backfilled, and code
-- before this migration never reads them. The revoke reasons gain `studio_not_delivered`
-- (the Studio part refunded alone because it never started).

ALTER TABLE public.migrate_grants
  ADD COLUMN collector text NOT NULL DEFAULT 'studio_polar' CHECK (collector IN ('studio_polar', 'migrate')),
  ADD COLUMN payment_ref text,
  ADD COLUMN prepaid_starts_at timestamp with time zone,
  ADD COLUMN prepaid_ends_at timestamp with time zone,
  ADD COLUMN renewal_subscription_id text;

ALTER TABLE public.migrate_grants
  ADD CONSTRAINT migrate_grants_prepaid_shape CHECK (
    (prepaid_starts_at IS NULL AND prepaid_ends_at IS NULL)
    OR (collector = 'migrate' AND payment_ref IS NOT NULL AND prepaid_starts_at IS NOT NULL AND prepaid_ends_at > prepaid_starts_at)
  );

ALTER TABLE public.migrate_grants DROP CONSTRAINT IF EXISTS migrate_grants_revoked_shape;
ALTER TABLE public.migrate_grants
  ADD CONSTRAINT migrate_grants_revoked_shape CHECK (
    (revoked_at IS NULL AND revoked_reason IS NULL)
    OR (revoked_at IS NOT NULL AND revoked_reason IN ('refund_before_delivery', 'refund_after_delivery', 'delivery_failed', 'ops', 'studio_not_delivered'))
  );

ALTER TABLE public.workspaces
  ADD COLUMN prepaid_until timestamp with time zone,
  ADD COLUMN prepaid_plan text CHECK (prepaid_plan IN ('starter', 'pro'));

ALTER TABLE public.workspaces
  ADD CONSTRAINT workspaces_prepaid_shape CHECK ((prepaid_until IS NULL) = (prepaid_plan IS NULL));

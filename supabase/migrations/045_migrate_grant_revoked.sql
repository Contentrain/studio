-- 045: a withdrawn Migrate grant (S3 revoke).
--
-- Migrate asks Studio to revoke an order's grant when the order is refunded or its
-- delivery failed (`POST /api/migrate/grants/revoke`). The grant keeps WHEN and WHY, so
-- support can read it and Migrate's status answer says `revoked`. The reason is one of
-- the contract's (`@contentrain/types` MIGRATE_REVOKE_REASONS). Revoking never deletes
-- the row: the order still has to be explainable. Service-role only like the rest of the table.

ALTER TABLE public.migrate_grants
  ADD COLUMN revoked_at timestamp with time zone,
  ADD COLUMN revoked_reason text;

ALTER TABLE public.migrate_grants
  ADD CONSTRAINT migrate_grants_revoked_shape CHECK (
    (revoked_at IS NULL AND revoked_reason IS NULL)
    OR (revoked_at IS NOT NULL AND revoked_reason IN ('refund_before_delivery', 'refund_after_delivery', 'delivery_failed', 'ops'))
  );

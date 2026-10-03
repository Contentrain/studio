-- 044: a grant for a "Migrate with Studio" bundle (provision, S2).
--
-- The bundle is sold by Migrate before anything is delivered, so its grant has
-- neither an included trial nor a repository yet: `kind = 'bundle'` rows carry
-- `trial_days` NULL and `repo_owner` / `repo_name` NULL until the delivery
-- repository reaches Studio (install-url / claim step). A trial grant (031)
-- keeps all three, and says so with the CHECKs below.
--
-- The grant also remembers the Polar checkout it opened, so a repeated
-- provision for the order returns the same checkout while it is payable
-- instead of opening a second one that could be paid twice.
--
-- The first invoice rides on an ad-hoc price; the webhook moves the new
-- subscription to the list product (effective at the next period). Until it
-- does, renewal would charge the ad-hoc price again, so the target product and
-- the moment the move was confirmed live here for the reconciler:
-- `bundle_target_product_id` set + `bundle_applied_at` NULL = still to move.
--
-- Service-role only like the rest of the table.

ALTER TABLE public.migrate_grants
  ADD COLUMN kind text NOT NULL DEFAULT 'trial' CHECK (kind IN ('trial', 'bundle')),
  ADD COLUMN checkout_id text,
  ADD COLUMN checkout_url text,
  ADD COLUMN checkout_expires_at timestamp with time zone,
  ADD COLUMN amount_cents integer CHECK (amount_cents IS NULL OR amount_cents > 0),
  ADD COLUMN bundle_target_product_id text,
  ADD COLUMN bundle_applied_at timestamp with time zone;

ALTER TABLE public.migrate_grants
  ALTER COLUMN trial_days DROP NOT NULL,
  ALTER COLUMN repo_owner DROP NOT NULL,
  ALTER COLUMN repo_name DROP NOT NULL;

ALTER TABLE public.migrate_grants
  ADD CONSTRAINT migrate_grants_trial_shape CHECK (kind <> 'trial' OR (trial_days IS NOT NULL AND repo_owner IS NOT NULL AND repo_name IS NOT NULL)),
  ADD CONSTRAINT migrate_grants_repo_pair CHECK ((repo_owner IS NULL) = (repo_name IS NULL));

-- The reconciler's work list: bundle subscriptions not yet moved to the list product.
CREATE INDEX idx_migrate_grants_bundle_pending ON public.migrate_grants (redeemed_at)
  WHERE kind = 'bundle' AND bundle_target_product_id IS NOT NULL AND bundle_applied_at IS NULL;

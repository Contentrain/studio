# Payment providers

Studio uses a plugin registry for payment providers. Polar is the
default; Stripe is supported as an opt-in secondary plugin.

## Architecture at a glance

```
server/providers/payment/
  types.ts           PaymentProvider + PaymentProviderPlugin contracts
  registry.ts        register/resolve + preference-ordered default
  index.ts           bootstrapPaymentPlugins() + public re-exports
  plugins/
    polar.ts         Polar MoR — hosted checkout, portal, meter events
    stripe.ts        Legacy Stripe — no-op for real-time metering
```

Billing state is stored in the `payment_accounts` table (one active row
per workspace). Meter events flow through `usage_events_outbox`: app
code writes rows via `server/utils/usage-metering.ts`; the
`server/plugins/usage-drain.ts` Nitro plugin picks them up every 30s
and dispatches to the active provider's `ingestUsageEvent`.

## Polar setup

Polar is the default provider. New deployments point at Polar unless
it's explicitly disabled by leaving `NUXT_POLAR_ACCESS_TOKEN` unset.

**1. Create the organisation + products.** In the Polar dashboard:

- Create an organisation (same environment — sandbox for development).
- Create two products, Starter and Pro, each with a recurring monthly
  price matching `PLAN_PRICING` in `shared/utils/license.ts` ($9 and
  $49 at the time of writing).
- Note each product's UUID — those go into the env file below.

**2. Sync meters + products + prices.** Run the content-driven sync:

```bash
NUXT_POLAR_ACCESS_TOKEN=polar_oat_… NUXT_POLAR_SERVER=sandbox \
  pnpm polar:sync
```

The script is idempotent and content-driven. On every run it:

- Creates the six meters if missing (`ai_messages`, `api_messages`,
  `mcp_calls`, `form_submissions`, `cdn_bandwidth_bytes`,
  `media_storage_byte_hours` — from `shared/utils/usage-meters.ts`).
- Creates Starter + Pro products if missing, stamped with
  `metadata.contentrain_slug` so future runs find them reliably.
  Name and description mutate in place when content changes.
- Creates the fixed monthly price (from `plans/en.json`) and the six
  metered prices (from `plan-features` overage rows + `OVERAGE_PRICING`)
  if any are missing on the product.
- Detects **price drift**: if an existing price on Polar disagrees
  with the content-defined amount, the script warns and exits 1.
  Polar prices cannot be legally mutated once an active subscription
  references them — to change prices, archive the old price in the
  Polar dashboard, create a new one, and switch the product's default.
  The script refuses to do this automatically so it never risks
  breaking live customer billing.

First run prints a copy-paste block of product IDs for your env:

```
  NUXT_POLAR_STARTER_PRODUCT_ID=…
  NUXT_POLAR_PRO_PRODUCT_ID=…
```

**3. Webhook endpoint.** In the Polar dashboard:

- URL: `https://<your-domain>/api/billing/webhook/polar`
- Events: `subscription.*`, `order.paid`. Others are ignored.
- Copy the signing secret into `NUXT_POLAR_WEBHOOK_SECRET`.

**4. Env configuration.** Copy the entries from `.env.example`:

```bash
NUXT_POLAR_ACCESS_TOKEN=polar_oat_…
NUXT_POLAR_WEBHOOK_SECRET=…
NUXT_POLAR_STARTER_PRODUCT_ID=…
NUXT_POLAR_PRO_PRODUCT_ID=…
NUXT_POLAR_SERVER=sandbox   # or production
NUXT_PUBLIC_BILLING_ENABLED=true
```

## Adding a new provider

1. Implement `PaymentProviderPlugin` under
   `server/providers/payment/plugins/<key>.ts` — see `polar.ts` for
   the canonical shape.
2. Register the plugin inside `bootstrapPaymentPlugins()` in
   `server/providers/payment/index.ts`.
3. Add the provider's key to `DEFAULT_PREFERENCE` in
   `registry.ts` if it should be picked automatically.
4. Update the DB `payment_accounts.provider` CHECK constraint to
   include the new key (migration file).
5. Add env scaffolding in `nuxt.config.ts` + `.env.example` and
   document the dashboard setup here.

No other code changes are required — billing state, webhook routing,
and usage metering all flow through the registered plugin interface.

## Stripe as fallback

Stripe is still a registered plugin so legacy deployments keep
working. It does not support real-time metering; the plugin's
`ingestUsageEvent` is a no-op. If you need Stripe overage billing on
an old deployment, you need a separate invoice-item engine — the
legacy one was removed with the Polar migration.

## Self-hosted / no billing

When no plugin reports `isConfigured(config) === true`, the middleware
bypass treats all workspaces as starter-level and the usage drainer is
inert. This is the expected self-host default.

# Contentrain Enterprise Edition

This directory contains proprietary features available with Contentrain Pro, Business, and Enterprise plans.

## Structure

```
ee/
  permissions/     — Advanced roles (reviewer, viewer, model restrictions)
  connectors/      — Premium integrations (Canva, Figma, Recraft, etc.)
  ai/              — Studio-hosted AI key management + metering
  workflow/        — Approval chains, scheduled publishing
```

## How It Works

Features are gated by `server/utils/license.ts`:

```ts
import { hasFeature, type Plan } from '~/server/utils/license'

if (hasFeature(plan, 'roles.reviewer')) {
  // Enable reviewer role
}
```

Core (AGPL) always works without ee/. EE features activate when workspace plan matches.

## License

See [LICENSE](./LICENSE) — proprietary, not AGPL.

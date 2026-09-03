# Deploy Hooks and Scheduled Publishing

Two things a Git-native static site does not get for free once its content
lives in Studio:

1. **A rebuild when content is published** on a host that is not watching
   the Git branch (or watches a different one), and
2. **A rebuild when a scheduled `publish_at` / `expire_at` passes** — no
   commit happens at that moment, so nothing would otherwise redeploy.

Both are covered by one project setting: a **deploy hook**.

## Deploy hook (S-02)

Every static host exposes a build hook: an HTTPS URL that rebuilds and
redeploys the site when POSTed — Netlify *build hooks*, Vercel *deploy hooks*,
Cloudflare Pages *deploy hooks*, or any endpoint of your own. Studio stores
one per project and POSTs it:

| reason | when | switch |
|---|---|---|
| `content_published` | after a `cr/*` branch lands on `contentrain` (merge, agent turn, auto-merge) | `triggers.on_publish` |
| `schedule` | when a scheduled publish/expire boundary passes | `triggers.on_schedule` |
| `manual` | the **Deploy now** button / `POST …/deploy/trigger` | always |

Automatic reasons are **debounced per project** (one leading call, one
trailing call per minute): a burst of merges produces one build. The hook
receives `{ "source": "contentrain-studio", "reason", "at" }` as JSON; hosts
ignore the body.

The URL is a credential. It is validated (`https`, public host — private
ranges and cloud-metadata hosts are refused like webhook URLs), encrypted with
the session secret, and stored on `projects.deploy_target`; only a hint
(`api.netlify.com/…efgh`) is ever returned. Each trigger stamps
`last_triggered_at` / `last_status` and emits the `deploy.triggered` webhook
event.

API (workspace owner/admin):

| route | body / result |
|---|---|
| `GET /api/workspaces/{ws}/projects/{p}/deploy` | `{ target: { provider, hookHint, triggers, lastTriggeredAt, lastStatus } \| null, scheduled: [...] }` |
| `PATCH …/deploy` | `{ provider?: 'netlify' \| 'vercel' \| 'cloudflare-pages' \| 'generic', hookUrl?, triggers?: { on_publish?, on_schedule? } }` — omit `hookUrl` to change only provider/switches |
| `DELETE …/deploy` | removes the hook |
| `POST …/deploy/trigger` | fires now (bypasses the debounce); `502` with the hook's status when the host refuses |

UI: the CDN panel of a project carries the **Deploy Hook** section.

The core implementation is the host-neutral `buildHookDeploymentProvider`
(`server/utils/deploy-hooks.ts`) behind the `DeploymentProvider` interface
(`server/providers/deployment.ts`). Vendor-specific extras (deploy status,
preview deploys) can be added in `ee/` behind the same interface.

## Scheduled publishing (S-03)

`publish_at` / `expire_at` are entry meta in Git (MCP 3.1.8). Delivery gates
on them at build time (`cdn-builder.ts`): a published entry is served once
`publish_at` has passed and until `expire_at`. What was missing was the
*trigger* at the boundary.

- Every save that carries a schedule (`SaveOptions.schedule`, i.e. the
  content editor's schedule fields and the agent's `schedule` argument)
  registers the future boundaries in `scheduled_publications` — one row per
  entry, locale and kind, replaced on re-save, dropped when the schedule is
  cleared, the date is already in the past, or the entry is deleted.
- The `schedule-trigger` Nitro plugin ticks every minute and claims every
  due boundary atomically (`claim_due_scheduled_publications`, `FOR UPDATE
  SKIP LOCKED`, so several instances never fire the same row). For each
  affected project it runs a full CDN rebuild (when delivery is enabled) and
  fires the deploy hook (when `on_schedule` is on), then emits the
  `schedule.fired` webhook event listing the boundaries.
- **Misfire policy: late, never lost.** A boundary that passed while Studio
  was down is claimed on the next tick. Rows are one-shot (`fired_at`).
- Timezone: dates are stored as UTC instants; the editor converts from the
  author's local time.

The pending boundaries of a project are listed in the Deploy Hook section and
via `GET …/deploy`.

## Environment

No new variables. The hook is encrypted with `NUXT_SESSION_SECRET` (and
`NUXT_SESSION_SECRET_PREVIOUS` during rotation), like OAuth provider tokens.

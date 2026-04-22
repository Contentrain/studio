# Contentrain Studio

Open-core product for team content management over Git. This repository contains the AGPL-3.0 core.
Conversation-first CMS — chat with AI agent to manage structured content.

## Stack

- **Framework:** Nuxt 4 (full-stack, single project — NOT monorepo)
- **UI:** Radix Vue (headless primitives) + Tailwind CSS 4 (CSS-based config, @theme)
- **Auth:** AuthProvider interface — current impl: Supabase Auth (GitHub OAuth, Google OAuth, Magic Link)
- **Database:** DatabaseProvider interface — current impl: Supabase PostgreSQL with RLS
- **Content engine:** `@contentrain/mcp` (core/ops + overlay-reader + validator + providers) + `@contentrain/types` (canonical contracts) + `@contentrain/query` SDK for UI strings. Studio composes `GitHubProvider` from `@contentrain/mcp/providers/github` with Studio extensions (tree listing, framework detection, PR helpers) — see `server/providers/git.ts`
- **Icons:** Annon custom icon set via @iconify/tailwind4
- **Images:** @nuxt/image (NuxtImg for all images)

## Architecture Decisions

### Provider/Adapter Pattern — CRITICAL

Studio is deployment-flexible. The AGPL core is self-hostable, and the same product model can also be operated as a managed Pro/Enterprise service.
All external services are accessed **only** through provider interfaces. No implementation detail ever leaks into components, pages, composables, or server routes.

Provider interfaces live in `server/providers/`:
- `server/providers/auth.ts` — AuthProvider interface
- `server/providers/database.ts` — DatabaseProvider interface
- `server/providers/storage.ts` — StorageProvider interface
- `server/providers/git.ts` — GitProvider interface

Concrete implementations live alongside interfaces in `server/providers/`, named `[impl]-[service].ts`:
- `server/providers/supabase-auth.ts` — SupabaseAuthProvider
- `server/providers/supabase-db.ts` — SupabaseDatabaseProvider (future)

**Rules — never violate:**
- NEVER import `@supabase/supabase-js` outside of `server/providers/impl/`
- NEVER use `useSupabaseClient()`, `useSupabaseUser()`, `useSupabaseSession()` in components or pages
- NEVER use `@nuxtjs/supabase` auto-injected composables outside the adapter layer
- NEVER write Supabase-specific SQL (RLS policies, `auth.users` joins) in application logic — only in migration files
- ALL auth checks in server routes use `AuthProvider.getSession()`, never the Supabase client directly
- Provider instances are resolved via a factory/injection in `server/utils/providers.ts`

**Current implementation:** Supabase (Auth + PostgreSQL).
**Alternative implementations** (future): standard OAuth + plain PostgreSQL, Auth0, Clerk, etc.
Any new provider implementation must satisfy the same interface — zero application code changes required.

### Payment providers (plugin registry)

Billing runs through a plugin registry at `server/providers/payment/`.
Each provider ships as a `PaymentProviderPlugin` (`key`, `label`,
`isConfigured`, `create`). The registry resolves the active plugin
using a preference order (currently `polar` → `stripe`). Billing state
lives on `payment_accounts` (one active row per workspace); meter
events flow through `usage_events_outbox` and a drain cron.

**Rules — never violate:**
- NEVER call Stripe or Polar SDKs outside `server/providers/payment/plugins/<key>.ts`
- NEVER read/write `payment_accounts` or `usage_events_outbox` outside
  `DatabaseProvider` methods
- To add a provider: new plugin file + one line in `bootstrapPaymentPlugins()`. No other core changes.
- To record a usage event: call the typed helper in `server/utils/usage-metering.ts`. Don't write to the outbox directly.
- See `docs/PAYMENT_PROVIDERS.md` for the full setup + extension guide.

### Auth
- Owner: GitHub OAuth (needs repo access)
- Invited users: Google OAuth or Magic Link (no password)
- Session: h3 useSession() AES-256 encrypted httpOnly cookie, auto-refresh
- Provider factory: `useAuthProvider()` singleton via `server/utils/providers.ts`
- Two-tier roles:
  - Workspace: Owner, Admin, Member
  - Project: Editor, Reviewer, Viewer
- Model-specific access: `specificModels` + `allowedModels` on project_members
- Chat agent security: permissions in system prompt + API-level enforcement

### Workspace Hierarchy
```
User → Workspace (billing entity) → Project (connected repo)
```
- Signup auto-creates personal workspace (type: primary)
- Workspace Owner/Admin → implicit access to all projects
- Workspace Member → needs explicit project_members assignment
- GitHub App installation lives on workspace (not project)

### Route Structure
This repository is the AGPL core product surface — no marketing pages. All routes are authenticated:
```
/auth/login ............... Auth (public)
/auth/callback ............ Auth callback (public)
/ ......................... Workspace list (or redirect to default)
/w/:slug .................. Workspace dashboard — project list
/w/:slug/projects/new ..... Connect repository
/w/:slug/projects/:id ..... Project workspace (three-panel)
/w/:slug/settings ......... Workspace settings (overview, members, github, ai-keys)
/settings ................. User account settings (profile, account deletion)
```

### Profile / Account Settings
- `/settings` page with tabs: Profile, Account
- Profile tab: display name (editable), avatar (read-only from OAuth), email (read-only), connected account badge
- Account tab: danger zone — account deletion guarded by typed-email confirmation (user re-types their own address in the UI; no outbound confirmation email is sent)
- API: `PATCH /api/profile` (update displayName), `DELETE /api/profile` (delete account — CASCADE)
- Database: `profiles` table via DatabaseProvider (`getProfile`, `updateProfile`)
- Auth: `AuthProvider.deleteUser()` for GDPR account deletion
- Sidebar shows `displayName` (fallback: email prefix), clickable → `/settings`

## Color System — CRITICAL

Exact match of old Contentrain CMS tailwind-preset. NEVER violate these rules:

### NEVER use raw Tailwind colors
- NO `gray-*` — use `secondary-*` (= slate)
- NO `red-*` — use `danger-*`
- NO `green-*` — use `success-*`
- NO `yellow-*` / `amber-*` — use `warning-*`
- NO `blue-*` — use `primary-*`
- NO `purple-*` / `indigo-*` — use `info-*`

### Palette names
- `primary` (brand blue 50-900)
- `secondary` (slate/neutral 50-950) — ALL neutral UI
- `success` (green 50-900)
- `warning` (amber 50-900)
- `danger` (red 50-900)
- `info` (purple 50-900)

### Semantic single-value tokens (light mode shortcuts, no dark: prefix)
- `text-heading` — headings, strong text (secondary-900)
- `text-body` — body paragraphs (secondary-600)
- `text-muted` — helper/secondary text (secondary-400)
- `text-label` — form labels (secondary-500)
- `text-disabled` — disabled state (secondary-300)
- `border-border` — dividers, borders (secondary-200)
- `bg-error` — error backgrounds (danger-100)

### Backgrounds (need dark: prefix)
- Page: `bg-white dark:bg-secondary-950`
- Raised/card: `bg-secondary-50 dark:bg-secondary-900`
- Input: `bg-white dark:bg-secondary-900`

### Borders (need dark: prefix)
- Default: `border-secondary-200 dark:border-secondary-800`

### Dark mode text (need dark: prefix)
- Heading: `text-secondary-900 dark:text-secondary-100`
- Body: `text-secondary-600 dark:text-secondary-300`

### Mid-tone tokens (work in both modes, no dark: prefix)
- `text-muted`, `text-label` — these are mid-tone and readable on both light/dark

## No Hardcoded Strings

All user-facing text comes from Contentrain dictionary via `@contentrain/query` SDK:
```ts
const { t } = useContent()
t('auth.sign_in_title') // => "Sign in to your account"
```
Dictionary model: `ui-strings` in `.contentrain/content/system/ui-strings/en.json`

When adding new UI text:
1. Add the key/value to the dictionary via `contentrain_content_save` MCP tool
2. Run `npx contentrain generate` to update SDK client
3. Use `useContent().t('key')` in the component

## Component Architecture

Atomic design from old Contentrain CMS, refactored for Radix Vue + Tailwind 4:

```
app/components/
  atoms/          — Radix Vue primitives + Tailwind (HeadingText, BaseButton, FormInput, FormLabel, Logo, Avatar, Badge)
  molecules/      — Composed atoms (ProviderButtons, AuthLink, EmailButton)
  organisms/      — Business logic components (SigninWithProvider, ProfileOverviewPanel, WorkspaceMembersPanel)
```

> **Note:** No `templates/` layer — Nuxt layouts (`app/layouts/`) handle page-level wrappers.

### Rules
- All atoms use Radix Vue primitives where applicable
- All components support dark mode
- NuxtImg for all images (not <img>)
- Icons via `icon-[annon--home-2]` class (not inline SVG, except brand logos)

### Accessibility & Interactive Elements — CRITICAL

W3C + WCAG compliance for all interactive elements. NEVER violate these rules:

**Cursor:**
- Global `cursor: pointer` is set in `main.css` `@layer base` for `button`, `[role="button"]`, `a[href]`, `summary`, `select` — do NOT add `cursor-pointer` class to these elements individually
- `disabled:cursor-not-allowed` on disabled interactive elements (already handled in atoms)

**Button type attribute:**
- ALL `<button>` elements MUST have an explicit `type` attribute
- Default: `type="button"` — prevents accidental form submission
- Only use `type="submit"` inside `<form>` elements for the primary submit action
- BaseButton atom has `type` prop (default: `"button"`) and `variant` prop (ghost/primary/danger/secondary)

**Focus visibility (keyboard navigation):**
- ALL interactive elements MUST have `focus-visible` styles for keyboard accessibility
- Standard pattern: `focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50`
- Add `rounded` to inline links/buttons so the focus ring follows the shape
- Inputs use `focus:ring` (not `focus-visible`) — mouse focus indication is correct for form fields

**ARIA attributes:**
- Inputs with error state: `aria-invalid="true"`
- Inputs with description text: `aria-describedby` linking to description element
- Decorative icons (required asterisk, etc.): `aria-hidden="true"`
- NEVER use raw `<button>` without accessibility attributes in organisms — prefer atom components

## Icons

Annon icon set (800+ custom icons) via @iconify/tailwind4:
```html
<span class="icon-[annon--home-2] text-muted" />
<span class="icon-[annon--alert-triangle] text-danger-500" />
```
Brand SVGs (GitHub, Google logos) stay as inline SVG — they need exact brand colors.

## Layouts

- `auth` — split panel (form left, marketing right)
- `default` — sidebar-first (AppSidebar 240px + full-width main). No header.
- `workspace` — three-panel (sidebar 240px, chat, context 400px)

## Content Engine — After Faz S2

The write path delegates structural operations to
`@contentrain/mcp/core/ops` instead of implementing file assembly
itself. Every save / delete op composes:

1. Studio field validation (`validateContent` — re-exported from MCP
   since Faz S3, shape-aligned so call sites stay untouched).
2. MCP plan helper (`planContentSave` / `planContentDelete` /
   `planModelSave`) — produces a deterministic `FileChange[]` sorted
   by path, with canonical JSON (or markdown frontmatter for
   documents) already serialised via `canonicalStringify` from
   `@contentrain/types`.
3. Studio meta override (`applyStudioMetaOverrides` in
   `content-engine/helpers.ts`) — replaces MCP's `defaultMeta`
   (`status: 'draft'`, `updated_by: 'contentrain-mcp'`) with
   Studio's `autoPublish` + existing-status preservation +
   per-user `updated_by` semantics.
4. `OverlayReader` + `buildContextChange` — wraps the plan changes
   so `context.json` stats (entries per model, last-sync) reflect
   the post-commit state, not the pre-change base branch.
5. `provider.applyPlan({ branch, changes, message, author, base: 'contentrain' })`
   — atomic branch+commit via the GitHub Data API. `createBranch`
   is no longer called separately; `applyPlan` forks `base` when the
   branch is missing.

**Invariants to preserve** when touching this path:

- Content SSOT is the `contentrain` branch. Feature branches always
  fork from it via `applyPlan`'s default `base`. `config.repository
  .default_branch` (`main` / `master`) is informational — never the
  fork point.
- Post-change reads (for validation or context) go through
  `OverlayReader(reader, pendingChanges)` — raw reader shows the
  pre-change tree and will emit stale stats.
- Studio's `pinReaderToContentrain` wrapper defaults ref to
  `CONTENTRAIN_BRANCH` for every MCP read (MCP's helpers call
  `reader.readFile(path)` without a ref).

## Deferred TODOs

Medium:
- Mobile shell: hamburger + slide-over (button exists, handler + drawer missing)
- Branch health: no 80+ branch threshold, no auto-delete merged cr/* branches
- Brain cache: no GitHub webhook-triggered invalidation for external pushes (TTL-only, 10min)
- MCP Cloud endpoint: `server/api/mcp/v1/[projectId]/[...].ts` awaits `@contentrain/mcp` `resolveProvider` callback (per-request provider resolution). Foundations (license entries, `mcp_cloud_keys` table, usage RPC) shipped in Faz S6 — route implementation pending.

## Branch Model & Deploy Flow — CRITICAL

Studio runs a **trunk-based Git flow**. `main` is the single integration branch and the PR target for all work (contributor, agent, internal). Staging is a Railway deployment environment fed from `main`, **not** a long-lived Git branch. This matches the OSS-SaaS norm observed in Grafana, Mastodon, Nextcloud, Supabase, PostHog, Mattermost, cal.com, and most AGPL / open-core peers.

| Branch    | Role                                                     | Deploy target                 |
|-----------|----------------------------------------------------------|-------------------------------|
| `main`    | Trunk — default, PR target, OSS face, stable-at-HEAD     | `staging.contentrain.io` auto; prod on `v*` tag |
| `feat/*`  | Per-task feature branches                                | (no auto-deploy)              |
| `fix/*`   | Per-task bug-fix branches                                | (no auto-deploy)              |
| `cr/*`    | Contentrain MCP auto-generated content branches          | (auto-merged by MCP)          |

Optional maintenance branches (`release/X.Y`, `stable-X.Y`) may be cut **from** `main` for backports to a shipped release line — they are downstream of `main`, never upstream.

### Rules — never violate

- **Every PR targets `main`.** There is no `staging`, `develop`, or `next` branch in this repo.
- **Never push directly to `main`.** All changes go through PR + CI gate.
- **Release tags (`v*`) are cut from `main`** — they trigger the production deploy. See `docs/RELEASING.md`.
- **Self-hosters deploy from tagged releases** (`v0.1.0`, `v0.2.0`), not from `main` HEAD. `main` is stable-at-HEAD for CI purposes but tags are the supported deploy contract.
- **Staging environment ≠ staging branch.** Railway deploys every merge to `main` into `staging.contentrain.io` automatically, so the pre-prod verification lives in the deploy pipeline rather than in Git topology.
- **Commitlint is lenient for MCP auto-commits** — messages prefixed with `[contentrain]` are ignored by commitlint (see `commitlint.config.ts`). Every human commit must obey Conventional Commits.

### Contributor flow

1. Contributor forks, opens a branch from `main`
2. PR targets `main` (GitHub's default base, no extra step needed)
3. Forked PRs run CI but cannot deploy (GitHub secrets are not exposed to forks — intended security boundary)
4. Maintainer reviews + merges → Railway auto-deploys to `staging.contentrain.io`
5. When ready to ship, a maintainer cuts a version tag (`v*`) on `main` → prod deploy via `.github/workflows/release.yml`

## Dev Tooling

- Conventional Commits enforced by commitlint + husky (MCP `[contentrain]` commits ignored)
- `pnpm lint` / `pnpm lint:fix` — @nuxt/eslint with Stylistic (no Prettier)
- `pnpm release` — full local release gate (`release:check`) + changelog/version/tag flow; run from `main` on a clean tree
- lint-staged on pre-commit (only changed files)
- GitHub Actions CI on every push/PR to `main` (commit lint + build)

## Open Core Model & Editions — CRITICAL

Studio ships as **open-core**: AGPL-3.0 core + proprietary `ee/` directory under a separate license (see `ee/LICENSE`). The public-facing legal + deployment surface lives in `docs/LICENSING.md`, `docs/EDITIONS.md`, and `docs/DEPLOYMENT_PROFILES.md` — update those when policy changes.

### Editions — what actually differs

Edition is **orthogonal to plan tier**: a managed Enterprise customer and a self-hosted Community user see different code paths, even though both models share the `free`/`starter`/`pro`/`enterprise` tier vocabulary.

- **Community Edition** = `loadEnterpriseBridge()` returns `null` (either `ee/` is absent or failed to import). All workspaces resolve to the fixed `community` plan tier. Numerical limits are unenforced (self-hoster's own infrastructure). `requires_ee` features are hidden/404 regardless of plan.
- **Enterprise Edition** = `loadEnterpriseBridge()` returns a bridge instance. Plan tier is determined by the deployment profile (`managed` / `dedicated` / `on-premise`). Full feature set available subject to plan gating.

### Rules — never violate

- **ee/ directory** is proprietary — NEVER mix `ee/` code into core paths. The boundary is enforced by convention + by the `EnterpriseBridge` interface in `server/utils/enterprise.ts`.
- **Core must work without ee/** — every AGPL code path must degrade gracefully when the bridge is `null`. Current provider gaps in core (CDN provider, Media provider) are ee-resident by design; do not assume they exist in Community Edition.
- **Feature gating goes through `hasFeature(plan, feature, { edition })`** in `shared/utils/license.ts`. The helper honors both plan tier and the `requires_ee` flag on the feature row.
- **`requires_ee: true` is an AND gate, not OR** — even if the plan matrix grants a feature, `requires_ee` features are disabled in Community Edition.
- **NEVER hardcode plan checks** (e.g. `if (plan === 'enterprise')`) — always route through `hasFeature()` or `getPlanLimit()`.
- **Provider interfaces in core, implementations may be in ee/** — this is the pattern for CDN and Media today.
- **UI conditional rendering** uses `useDeployment()` (edition + plan + billing mode) consistently. Every surface that renders plan/billing/edition info (sidebar, overview, billing tab, usage, members, plan modal, trial banner) reads from the same composable.
- **Database schema stays in core** — `ee/`-related columns (e.g. `project_members.specific_models`) exist in migrations; RLS and application logic keep them unused in Community Edition.
- **Graceful degradation** — bridge-null paths must return sensible defaults (role → editor, metering → no-op, optional features → hidden), never throw 500s.
- **NEVER write to `payment_accounts` or `usage_events_outbox` outside `DatabaseProvider`** — the abstraction is part of the payment-plugin boundary.
- **NEVER import Stripe or Polar SDKs outside `server/providers/payment/plugins/<key>.ts`**.

### What belongs in ee/

Under `ee/LICENSE` scope. Requires an active Contentrain subscription or separately executed agreement.

- Advanced project roles: `reviewer`, `viewer`, `specificModels` (core degrades to `editor`)
- BYOA API key management UI + key rotation + encryption (`ai.byoa`)
- Studio-hosted AI key (`ai.studio_key`) — the Anthropic key billed to Contentrain
- Conversation API + conversation keys (`api.conversation*`)
- Outbound webhooks + delivery retry (`api.webhooks_outbound`, `api.webhooks`)
- CDN provider implementation (R2 driver, custom variants, preview branches, custom domain)
- Media provider implementation (upload, library, image processing)
- Spam filter (`forms.spam_filter`)
- Form file upload (`forms.file_upload` — depends on media stack)
- Form webhook notifications (`forms.webhook_notification` — depends on outbound webhooks)
- SSO (`sso.saml`, `sso.oidc`) — roadmap
- White-label branding (`branding.white_label`) — roadmap
- MCP Cloud custom domain + SSO — roadmap
- Advanced audit log UI (core exposes the read API)
- Approval chains, scheduled publish, premium connectors (Canva, Figma, Recraft, Notion, Google Drive)

### What stays in core (AGPL)

Always available, in every edition. Plan-independent.

- All auth flows (Supabase Auth + OAuth providers + magic link), workspace/project CRUD, member management (Owner/Admin/Member)
- Chat engine + every deterministic agent tool (content CRUD, validation, branch/merge, brain, search)
- Content CRUD — all 4 kinds (collection, singleton, document, dictionary), all 27 field types
- Auto-merge workflow (cr/* → contentrain → main), review workflow gating via `workflow.review`
- Content editor modal, all form components, validation, health reporting
- Owner + Admin + Editor workspace roles; Editor project role
- URL fetch connector
- Single + multi-locale (config-driven, not plan-gated)
- Forms core (submission storage, captcha via Turnstile, auto-approve, notifications via Resend)
- AI chat with operator-provided `NUXT_ANTHROPIC_API_KEY`

### Deployment profiles

Four profiles, auto-detected from `ee/` presence + billing env, overridable via `NUXT_DEPLOYMENT_PROFILE`:

- `managed` — ee required, subscription-driven plan (contentrain.io)
- `dedicated` — ee required, operator-set plan, single-tenant hosted
- `on-premise` — ee required, operator-set plan, customer infrastructure
- `community` — agpl only, fixed `community` tier, no billing

See `docs/DEPLOYMENT_PROFILES.md` for the 12-scenario matrix.

### AGPL §13 + trademark notices

`LICENSE-EXCEPTIONS` publishes two §7 additional terms for the core: attribution (§7(c)) and no-trademark (§7(e)). `/about` page and app footer expose the source-code link per §13. Do not remove these without legal review.

### Commercial safety rails

- Reselling or embedding `ee/` without an executed agreement is prohibited by `ee/LICENSE` §3.3, §3.4.
- Commercial SaaS resale of the AGPL core is **technically permitted** by AGPL-3.0 but the Contentrain trademark cannot be used for the reseller's product identity (`LICENSE-EXCEPTIONS` §7(e)). If stronger resale control is needed in the future, the model to evaluate is BSL (Business Source License) migration — this is a roadmap-level decision, not a patch-level change.

## Internal Planning

Long-form product, marketing, and implementation planning docs are kept outside the tracked repository on purpose.

### Roadmap

See `ROADMAP.md` (project root, git-tracked) for the full public roadmap.

## Reference Codebase

`.tmp/contentrain/` contains the old Contentrain headless CMS.
Used as architectural reference for UI patterns, role/permission system, and theme.
NOT part of Studio code — gitignored.

### Using Old CMS as Reference

The old CMS UI/UX is approved and is the visual/UX basis for Studio components.
You **can and should** port components/views from the old CMS — but take **only the UI/UX**, not the code.

**What to take from the old CMS:**
- Visual layout and spacing
- Component composition and flow (what goes where, in what order)
- User interaction patterns (form flows, button placement, navigation)

**What NOT to carry over:**
- Code structure, file naming, directory organization
- Old component/variable naming conventions
- Code quality issues, anti-patterns, TODOs, hacks
- Pinia store logic, Vue Router usage, Firebase/LuiButton imports
- Hardcoded strings

**How to port:**
- Rewrite from scratch using the old CMS as a visual reference
- Follow Studio's atomic structure: atoms → molecules → organisms
- Apply `skills-lock.json` (antfu) standards — linting, naming, code style enforced automatically
- Replace all tech references: Vue Router → NuxtLink, LuiButton → Radix atoms, Firebase → AuthProvider, hardcoded strings → `t('key')`, raw Tailwind colors → Studio palette, `<img>` → `<NuxtImg>`

Key auth paths to reference:
```
.tmp/contentrain/client/src/
  layouts/auth.vue                              → app/layouts/auth.vue
  components/organisms/SigninWithProvider.vue   → app/components/organisms/SigninWithProvider.vue
  components/organisms/SigninWithEmail.vue      → app/components/organisms/SigninWithEmail.vue
  pages/auth/signin.vue                         → app/pages/auth/login.vue
  atoms/ molecules/                             → app/components/atoms/ molecules/
```

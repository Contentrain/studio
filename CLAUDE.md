# Contentrain Studio

AGPL-3.0 licensed cloud product for team content management over Git.
Conversation-first CMS — chat with AI agent to manage structured content.

## Stack

- **Framework:** Nuxt 4 (full-stack, single project — NOT monorepo)
- **UI:** Radix Vue (headless primitives) + Tailwind CSS 4 (CSS-based config, @theme)
- **Auth:** AuthProvider interface — current impl: Supabase Auth (GitHub OAuth, Google OAuth, Magic Link)
- **Database:** DatabaseProvider interface — current impl: Supabase PostgreSQL with RLS
- **Content:** Contentrain MCP + @contentrain/query SDK for UI strings
- **Icons:** Annon custom icon set via @iconify/tailwind4
- **Images:** @nuxt/image (NuxtImg for all images)

## Architecture Decisions

### Provider/Adapter Pattern — CRITICAL

Studio is deployment-agnostic. There is no "hosted SaaS" — the product is self-hosted / on-premise first.
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
This is an AGPL product — no marketing pages. All routes are authenticated:
```
/auth/login ............... Auth (public)
/auth/callback ............ Auth callback (public)
/ ......................... Workspace list (or redirect to default)
/w/:slug .................. Workspace dashboard — project list
/w/:slug/projects/new ..... Connect repository
/w/:slug/projects/:id ..... Project workspace (three-panel)
/w/:slug/settings ......... Workspace settings, members, billing
/settings ................. User/account settings
```

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
  organisms/      — Business logic components (SigninWithProvider, SigninWithEmail)
```

> **Note:** No `templates/` layer — Nuxt layouts (`app/layouts/`) handle page-level wrappers.

### Rules
- All atoms use Radix Vue primitives where applicable
- All components support dark mode
- NuxtImg for all images (not <img>)
- Icons via `icon-[annon--name]` class (not inline SVG, except brand logos)

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

## Deferred TODOs

Tech debt (not phase-gated, fix when relevant):
- Rate limiting: in-memory → Redis/Upstash (production multi-instance deploy)
- Mobile shell: hamburger + slide-over (UI work)
- DatabaseProvider abstraction (only when adding second DB provider)
- Hardcoded strings: ongoing `t('key')` migration

## Dev Tooling

- Conventional Commits enforced by commitlint + husky
- `pnpm lint` / `pnpm lint:fix` — @nuxt/eslint with Stylistic (no Prettier)
- `pnpm release` — changelogen for changelog + version + tag
- lint-staged on pre-commit (only changed files)
- GitHub Actions CI on PRs (commit lint + build)

## Enterprise Edition (ee/) — CRITICAL

Studio uses **Open Core** model: AGPL core + proprietary `ee/` directory.
Full spec: `.internal/EE-SEPARATION.md`

### Rules — never violate:

- **ee/ directory** has its own proprietary LICENSE — NEVER mix ee/ code into core
- **Core must work without ee/** — free tier is a fully functional product
- **Feature flags** via `server/utils/license.ts` → `hasFeature(plan, 'feature.name')`
- **NEVER hardcode plan checks** — always use `hasFeature()` function
- **Provider interfaces in core**, implementations can be in ee/ (same pattern as AuthProvider)
- **UI conditional rendering** based on plan — use `hasFeature()` in computed properties
- **Database schema stays in core** — ee/ columns exist but are unused/RLS-gated in free tier
- **Graceful degradation** — if ee/ feature is unavailable, degrade safely (reviewer → editor, not error)

### What belongs in ee/:
- Advanced roles (reviewer, viewer, specificModels)
- BYOA API key management
- Premium connectors (Canva, Figma, Recraft, Notion, Google Drive)
- SSO (SAML, OIDC)
- Approval chains, scheduled publish
- Audit log, activity feed
- White-label branding
- Outbound webhooks, public REST API

### What stays in core (AGPL):
- All auth flows, workspace/project CRUD
- Chat engine + all agent tools
- Content CRUD (all 4 kinds, all 27 field types)
- Auto-merge workflow, branch creation
- Content editor modal, all UI components
- Owner + Editor roles
- URL fetch connector
- Single + multi-locale (config-driven, not plan-gated)

## Internal Documents

Active specs in `.internal/`:
- `STUDIO-SPEC.md` — master product & architecture spec
- `EE-SEPARATION.md` — Open Core / EE boundary rules
- `MARKETING.md` — go-to-market strategy
- `IDEAS.md` — product ideas with feasibility analysis
- `CONVERSATION-API.md` — external AI content ops (Business+) — not yet implemented
- `FORMS-SUBMISSIONS.md` — content-in via public forms — not yet implemented
- `SCHEMA-VALIDATION.md` — model integrity & breaking change detection — not yet implemented

## Current Phase

**Phase 4 completed.** Media Management — upload, optimize, variants, blurhash, asset manager UI, agent tools, CDN integration.

Completed phases:
- Phase 1: Foundation + Content Browsing
- Phase 2: Chat Engine + Content Editing
- Phase 3: CDN Content Delivery
- Phase 4: Media Management

### Roadmap (next)

| Sprint | Focus | Efor | Plan | Spec |
|--------|-------|------|------|------|
| Next | Project Health (schema validation + dashboard) | 2 hafta | Free | `SCHEMA-VALIDATION.md` |
| +1 | Forms & Submissions | 2-3 hafta | Free+ | `FORMS-SUBMISSIONS.md` |
| +2 | Conversation API + Content REST API | 2-3 hafta | Business+ | `CONVERSATION-API.md` |
| +3 | Webhook Outbound | 2 hafta | Business+ | `IDEAS.md` |
| +4 | Multi-Repo Governance | 2 hafta | Enterprise | İhtiyaç doğduğunda |

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

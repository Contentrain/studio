# Contentrain Studio — Product & Architecture Specification v2

> This document supersedes STUDIO-PRODUCT-SPEC.md and STUDIO-TECH-SPEC.md.
> It reflects the architectural clarity that Studio is an independent product
> sharing only standards (types/rules) with the open-source monorepo.
> Last updated: 2026-03-17

---

## The Two Products

Contentrain has two distinct products that serve different stages of the content lifecycle:

```
MONOREPO (contentrain-ai)              STUDIO (contentrain-studio)
─────────────────────────              ──────────────────────────
Developer's local environment          Cloud product for teams

Structures content in code:            Manages structured content:
  - init, normalize, extract             - browse, edit, review
  - model creation                       - translate, approve
  - content generation                   - deliver (CDN, media)
  - source patching                      - collaborate (teams, roles)
  - SDK generation                       - extend (scheduling, analytics)

MCP + CLI + SDK                        Own API + GitHub/GitLab/Bitbucket

Runs locally, filesystem               Runs in cloud, API-driven
Single developer                       Teams, non-developers
Free, MIT licensed                     Free tier + paid tiers, AGPL
```

**What they share:**
- `@contentrain/types` — the file format standard (how models, content, config, meta are structured)
- `@contentrain/rules` — the quality standard (what's valid, naming conventions, constraints)

**What they don't share:** Implementation. Zero shared runtime code. MCP doesn't know Studio exists. Studio doesn't know MCP exists. They both read and write the same `.contentrain/` file format.

**Analogy:** Git CLI and GitHub. Git CLI works locally on your filesystem. GitHub works in the cloud via API. They share the Git protocol/format, not implementation. You can use either independently. Together they're more powerful.

---

## What Studio Is

Studio is where **structured content gets managed by teams and delivered to platforms.**

It assumes content is already structured — whether by a developer using the monorepo tools, or by a team working directly in Studio. Studio doesn't care how the content got into `.contentrain/`. It manages what's there.

**One sentence:** Studio is the team governance layer and delivery network for structured content in Git.

**What Studio is NOT:**
- Not an MCP wrapper or MCP UI
- Not a code analysis tool (no codebase access, no normalize)
- Not a CMS in the traditional sense (chat-first, not form-first)
- Not an AI product (BYOA)

---

## Why Studio Exists (Three Gaps)

### Gap 1: Non-Developer Access

Marketers, founders, editors, translators cannot use CLI/MCP/Git. Every content change requires a developer. Studio breaks this bottleneck: talk to an agent in a browser, see content visually, approve changes.

**Revenue trigger:** Team seats.

### Gap 2: Content Delivery

`.contentrain/` files live in Git. Web projects read them at build time — fine. But iOS, Flutter, React Native, desktop apps, game engines, email services need content over HTTP.

**Revenue trigger:** CDN bandwidth.

### Gap 3: Content Operations at Scale

As content grows (500+ entries, 5+ locales, 10+ models), teams need: visual browsing, bulk operations, translation workflows, scheduling, analytics, media management. These are cloud product capabilities that don't belong in a local CLI.

**Revenue trigger:** Pro/Team features.

---

## Core Principle: Conversation-First

### The Input Hierarchy

Studio's primary input is always natural language — written or spoken. Everything else is secondary.

```
1. Chat (typing)       — PRIMARY. Always available, every operation.
2. Voice (speaking)    — Chat's voice variant. Same flow, speech-to-text.
3. Inline edit (click) — SHORTCUT. Quick typo fix in context panel.
4. Schema-backed form  — INVISIBLE. Validation layer behind inline edit.
                         User never feels like they're "filling a form."
```

**What Studio is NOT:** A form-based CMS. There is no "New Content" button that opens a blank form. There is no "Edit" page with labeled fields. Content creation and modification happens through conversation.

### Why Conversation-First

Contentrain's philosophy is "agent generates, human approves." A form-based editor contradicts this. If the user fills out a form, we're just another CMS with a Git backend.

Chat means:
- User says **what** they want: "Change the hero title to X and translate to Turkish"
- Agent figures out **how**: which model, which field, which locale, which API call
- System shows the **result**: diff, preview, approve/reject

The user never needs to know what a "singleton" is, how locales work, or what JSON looks like.

Voice extends this naturally. A microphone button beside the chat input. Speak, transcribe, send. The same flow, no keyboard required. v1 uses browser Speech-to-Text API. Future: real-time voice conversation with the agent.

### Why Visual Exists (But Secondary)

- **Browsing:** Sidebar with models, content list — faster than asking chat
- **Quick typo:** Click a field in context panel, fix one character — faster than describing it
- **Review:** Diff viewer, approve/reject buttons — UI elements, not chat
- **Scanning:** See all fields at once to check completeness

The context panel shows inline-editable fields. This looks like a document, not a form. Click a field, edit in place, save. Behind the scenes, schema validation runs, branch is created, commit is made. The user feels like editing a document, not filling a form.

**Rule:** Conversation for creation and complex operations. Visual for browsing and quick edits. Forms never.

### Agent Reliability and Standardization

A critical question: if agents make mistakes even with MCP locally, how does Studio guarantee correct content?

**The answer: Studio API is the gatekeeper.**

In IDE: Agent → MCP → filesystem. MCP validates, but agent can theoretically bypass MCP and write files directly.

In Studio: Agent → Studio API → Git Provider API. **There is no bypass.** Every content write goes through the Content Engine, which validates against @contentrain/types schemas and @contentrain/rules quality standards. Invalid content is rejected before it reaches Git.

Additionally, Studio's agent tools are **guided, not freeform:**

```
Agent wants to save content →
  Studio API responds: "hero-section is a singleton with fields:
    title (string, required), subtitle (string), cta (string).
    Locale: en. Send your data."
  Agent sends: { "title": "...", "subtitle": "...", "cta": "..." }
  Studio API validates every field → saves or rejects with specific error.
```

The agent doesn't guess the schema. The API tells it exactly what's expected at every step. Combined with hard validation, **Studio guarantees content standardization in a way that local MCP cannot.**

---

## Agent Access Model

### The Onboarding Problem

A marketer is invited to Studio. They sign in, see the project, want to change the hero title. They type in chat. But: they don't have an Anthropic or OpenAI API key. They don't know what that is.

If we show "Enter API key" → they bounce. First experience destroyed.

### The Solution: Studio-Hosted Agent + BYOA Option

```
Free tier (50 onboarding messages):
  Studio provides a lightweight model (Haiku-class) at Studio's cost.
  ~$0.05 per user for 50 messages. Negligible CAC.
  After 50 messages: "Add your own API key (free) or upgrade to Pro"

Free tier (BYOA):
  User adds their own API key → unlimited chat, their model choice.

Pro tier ($14/month):
  Studio-hosted agent included (Sonnet-class, 500 messages/month).
  BYOA also supported (user can override with their own key/model).

Team tier ($34/month + seats):
  Studio-hosted agent included (Sonnet-class, 2000 messages/month).
  BYOA also supported.
```

**Key points:**
- BYOA is always an option, never a requirement (except Free after 50 messages)
- Studio-hosted agent uses the cheapest adequate model per tier
- The agent is scoped to content operations only — it cannot be used for general chat
- Abuse prevention: rate limit (10 msg/min), content-tools-only system prompt, hard message cap

### Agent Scoping (Abuse Prevention)

Studio's agent system prompt enforces content-only operations:

```
"You are a content management assistant for Contentrain Studio.
You can ONLY help with content operations using the provided tools.
You cannot write code, answer general questions, or perform non-content tasks.
Every response must include at least one tool call."
```

If user says "write me a poem": agent redirects to content operations. The agent literally cannot do anything else because its only tools are content management tools.

---

## Onboarding: How Users Start

### Path A: Contentrain Already Initialized

Developer used monorepo tools locally (`contentrain init` + MCP). Pushed to GitHub. Comes to Studio.

```
GitHub auth → repo list → select repo →
Studio scans for .contentrain/config.json → found →
Project connected → browse content immediately
```

Instant value. No setup needed in Studio.

### Path B: Existing Repo, No Contentrain

User has a repo (Nuxt app, Next.js site, Flutter project, etc.) and wants to try Studio. No `.contentrain/` exists.

**Studio handles everything through conversation:**

```
User selects repo → Studio scans → no .contentrain/ found →

Agent: "This project doesn't have Contentrain set up yet.
        I'll configure it for you. Let me look at your project..."

        [reads package.json, detects framework, checks for i18n config]

Agent: "I see a Nuxt 3 project with vue-i18n configured.
        What languages do you want to support?"

User: "English and Turkish"

Agent: "Got it. What content do you want to manage?
        For example: landing page sections, blog posts, UI labels, FAQ..."

User: "Hero section and FAQ for now"

Agent: → Creates .contentrain/config.json (stack: nuxt, locales: [en, tr])
       → Creates hero-section model (singleton, content_path based on framework)
       → Creates faq model (collection)
       → Commits via GitHub API
       → "Done. Let's add your first content."

User: "Hero title is 'Build faster with AI', subtitle is..."

Agent: → Saves content → shows diff → user approves
```

**30 seconds from "I want to try" to first content. No terminal. No local install.**

### Framework Detection and Content Path

Studio reads the repo tree via GitHub API and makes smart decisions:

```
package.json → framework detection:
  "nuxt" in dependencies        → stack: nuxt
  "next" in dependencies        → stack: next
  "astro" in dependencies       → stack: astro
  "@sveltejs/kit" in deps       → stack: sveltekit
  "vue" in dependencies         → stack: vue
  "react" in dependencies       → stack: react

pubspec.yaml exists             → stack: flutter
build.gradle exists             → stack: android
Package.swift exists            → stack: ios
go.mod exists                   → stack: go
```

Based on detection, Studio sets optimal `content_path` per model:

| Detected Stack | Default content_path | Why |
|---|---|---|
| Nuxt (with Nuxt Content) | `content/{model}/` | Nuxt Content auto-reads from `content/` |
| Astro | `src/content/{model}/` | Astro Content Collections convention |
| Any other web framework | `.contentrain/content/{domain}/{model}/` | Standard, consumed via SDK or CDN |
| Mobile (Flutter/iOS/Android) | `.contentrain/content/{domain}/{model}/` | Consumed via CDN |
| Non-JS (Go, Python, Rust) | `.contentrain/content/{domain}/{model}/` | Consumed via CDN or direct read |

### Content Consumption Guidance

After content is created, Studio guides the user on how to connect it to their app:

**Nuxt Content detected:**
```
Agent: "Your content is written to content/{model}/. Nuxt Content picks this
        up automatically. Just run `git pull` in your local project and
        your dev server will show the new content. Zero code changes needed."
```

**Astro detected:**
```
Agent: "Content is in src/content/{model}/. Astro Content Collections will
        detect it automatically. Pull and restart your dev server."
```

**Next.js / React / Vue / Svelte detected:**
```
Agent: "Content is in .contentrain/. You have three options to use it:

        1. CDN (recommended for teams):
           Enable CDN in project settings. Fetch content:
           fetch('https://cdn.contentrain.io/{project}/hero-section/en.json')

        2. Generated SDK (TypeScript projects):
           Run in your terminal: npx contentrain generate
           Then import: import { singleton } from '#contentrain'

        3. Direct JSON read:
           Read .contentrain/content/ files directly in your build."
```

**Mobile / Non-web detected:**
```
Agent: "Your project isn't web-based, so content delivery works via CDN.
        Enable CDN in project settings, then fetch:
        GET https://cdn.contentrain.io/{project}/hero-section/en.json

        This works from any platform — iOS, Android, Flutter, Go, Python."
```

### Path C: No Repo Yet

User just wants to explore Studio without a project.

```
GitHub auth → "Create a new project or connect existing repo?"
→ "Connect existing" → Path A or B
→ "Try with demo" → Studio provides a read-only demo project
   Pre-populated with sample models and content
   User can chat, browse, see how it works
   "Ready to connect your own repo?" → Path A or B
```

Demo project = zero-friction exploration. No repo needed. When ready, connect real repo.

---

## User Personas

### Developer

**Arrives:** MCP hint returns Studio URL, or wants to share review link with team.
**Does:** Reviews branches, shares links, configures CDN, invites team.
**Doesn't:** Create content (uses IDE/MCP for that).

### Content Editor / Marketer

**Arrives:** Invited by developer.
**Does:** Chats with agent to create/modify content, inline-edits typos, reviews and approves.
**Needs to NOT know:** Git, JSON, branches, models, schemas, locales.

### Translator

**Arrives:** Invited by editor or developer.
**Does:** Sees side-by-side locale content, translates via chat or inline, reviews translations.

### Founder / PM

**Arrives:** Invited, wants oversight.
**Does:** Browses content, sees activity feed, approves/rejects.

---

## Architecture

### The Key Insight: No Clone, No MCP, No Disk

Studio reads and writes `.contentrain/` files through the Git provider API (GitHub, GitLab, Bitbucket). No server-side clone. No worktrees. No filesystem operations. No MCP execution.

```
┌─────────────────────────────────────────────────────┐
│  BROWSER                                            │
│  ┌───────────┐  ┌────────┐  ┌──────────────────┐  │
│  │ IndexedDB │  │ Chat   │  │ Context Panel    │  │
│  │ (content  │  │ Panel  │  │ (reactive,       │  │
│  │  cache)   │  │        │  │  inline-editable)│  │
│  └─────┬─────┘  └───┬────┘  └──────────────────┘  │
│        │            │                               │
│  ┌─────▼────────────▼──────────────────────────┐   │
│  │ Service Worker (background sync, offline Q) │   │
│  └──────────────────┬──────────────────────────┘   │
└─────────────────────┼──────────────────────────────┘
                      │ HTTPS / WSS / SSE
                      ▼
┌─────────────────────────────────────────────────────┐
│  SERVER (stateless, no disk)                        │
│  ┌──────┐  ┌────────┐  ┌─────┐  ┌──────────────┐  │
│  │ Auth │  │ Chat   │  │ CDN │  │ Content      │  │
│  │      │  │ Engine │  │ Pub │  │ Engine       │  │
│  └──┬───┘  └───┬────┘  └──┬──┘  └──────┬───────┘  │
│     │          │           │            │           │
│     │     ┌────▼───────────▼────────────▼──────┐   │
│     │     │  ContentProvider (abstraction)      │   │
│     │     └────────────────┬───────────────────┘   │
└─────┼──────────────────────┼───────────────────────┘
      │                      │
      ▼                      ▼
┌──────────┐       ┌────────────────────┐
│ GitHub   │       │ Git Provider API   │
│ App      │       │ (GitHub v1,        │
│ (OAuth)  │       │  GitLab v2,        │
└──────────┘       │  Bitbucket v3)     │
                   └────────────────────┘
```

### Content Engine (Server)

Studio's own content management layer. **Not MCP.** Implements the same standard (types/rules) independently.

```
Content Engine responsibilities:
  - Read .contentrain/ files via Git Provider API
  - Validate content against model schemas (using @contentrain/types)
  - Apply quality rules (using @contentrain/rules)
  - Canonical JSON serialization (using shared format utilities)
  - Create branches, commits, PRs via Git Provider API
  - Merge/reject branches
  - Track operations for activity log
```

The Content Engine exposes a REST API that the chat agent and the browser UI both consume:

```
POST /api/projects/{id}/content/{model}
  → validates, creates branch, commits, returns diff

PUT  /api/projects/{id}/content/{model}/{entry}
  → updates entry, commits to branch

GET  /api/projects/{id}/content/{model}?locale=en
  → returns content entries

POST /api/projects/{id}/branches/{name}/merge
  → merges branch (or creates PR if branch protection exists)
```

### Chat Engine (Server)

BYOA agent that calls Studio's own API — not MCP tools.

```
User message arrives →
  Build system prompt:
    - Project schema (from types)
    - Quality rules (from rules)
    - Studio API tool definitions
    - Current project state (models, locales, recent activity)

  Call AI provider (user's API key) →
  Stream response via SSE →
  When agent calls a tool:
    → Execute Studio API internally
    → Return result to agent
    → Continue streaming
```

**Studio agent tools (NOT MCP tools):**

| Tool | What It Does |
|---|---|
| `list_models` | List all models with field schemas |
| `get_content` | Read content for a model/locale |
| `save_content` | Create/update content (creates branch + commit) |
| `delete_content` | Remove content entries |
| `save_model` | Create/update model definition |
| `validate` | Run validation against schemas |
| `list_branches` | Show pending contentrain/* branches |
| `merge_branch` | Approve and merge a branch |
| `reject_branch` | Close/delete a branch |
| `copy_locale` | Bulk copy content to a new locale |
| `translate` | Translate content (agent does the translation, tool saves it) |

These tools call the Content Engine internally. They follow the same rules and produce the same output format as MCP — but they're Studio's own implementation.

### Browser Layer

**IndexedDB as content cache:**

```
First load:
  GET /api/projects/{id}/snapshot → all .contentrain/ files as JSON
  → Store in IndexedDB
  → Render UI from IndexedDB (instant)

Subsequent loads:
  Read from IndexedDB (instant render) →
  Background: GET /api/projects/{id}/snapshot/delta?since={sha}
  → Only changed files → update IndexedDB → UI reactively updates

WebSocket event:
  "content:updated" → trigger delta sync → IndexedDB update → UI update

Offline:
  Read: works (IndexedDB)
  Write: queued in IndexedDB → synced when online (Background Sync API)
```

**Three-panel layout:**

```
┌──────────┬──────────────────┬──────────────────────┐
│ Sidebar  │ Chat Panel       │ Context Panel        │
│ 240px    │ flex-1           │ 400px, collapsible   │
│          │                  │                      │
│ Projects │ Conversation     │ Content viewer       │
│ Models   │ with agent       │ Diff viewer          │
│ Branches │                  │ Inline-editable      │
│ Activity │ Tool execution   │ fields               │
│ Settings │ indicators       │                      │
│          │                  │ Locale switcher      │
│          │ [Approve/Reject] │ [Save] [Discard]     │
└──────────┴──────────────────┴──────────────────────┘
```

### Git Provider Abstraction

```
interface ContentProvider {
  // File operations (scoped to .contentrain/)
  readFile(path: string, ref?: string): Promise<string>
  listDirectory(path: string, ref?: string): Promise<string[]>
  getTree(ref?: string): Promise<TreeEntry[]>

  // Branch operations
  createBranch(name: string, fromRef?: string): Promise<void>
  listBranches(prefix?: string): Promise<Branch[]>
  getBranchDiff(branch: string, base?: string): Promise<FileDiff[]>
  mergeBranch(branch: string, into: string): Promise<MergeResult>
  deleteBranch(branch: string): Promise<void>

  // Commit operations
  commitFiles(branch: string, files: FileChange[], message: string): Promise<Commit>

  // PR operations (when branch protection requires it)
  createPR(head: string, base: string, title: string, body: string): Promise<PR>
  mergePR(id: string): Promise<void>

  // Webhook
  registerWebhook(events: string[]): Promise<void>

  // Permissions
  getPermissions(): Promise<RepoPermissions>
  getBranchProtection(branch: string): Promise<BranchProtection | null>
}
```

v1: `GitHubAppProvider` — uses GitHub App installation tokens.
v2: `GitLabProvider` — uses GitLab OAuth + API.
v3: `BitbucketProvider` — uses Bitbucket App.

### Shared Format Layer

The only runtime code shared between monorepo and Studio:

```
@contentrain/types:
  - TypeScript interfaces (ModelDefinition, FieldDef, ContentrainConfig, etc.)
  - Validation utilities (validateModel, validateContent, validateConfig)
  - Serialization utilities (canonicalJson, serializeContent, parseContent)

@contentrain/rules:
  - Quality rule definitions (content-quality, schema-rules, i18n-quality)
  - Validation rule implementations (field constraints, naming conventions)
```

Both MCP and Studio import these. Format is guaranteed identical. Implementation is independent.

**Risk mitigation for format drift:** CI test that creates content with MCP, reads it with Studio's Content Engine (and vice versa). If the output differs, the test fails.

---

## Phases (Revised)

> **Status as of 2026-03-26:** Phases 1-4 completed. Roadmap below updated.

### Phase 1: Foundation + Content Browsing ✅ COMPLETED

**What:**
- GitHub App setup (OAuth, installation flow, webhook registration)
- ContentProvider implementation (GitHubAppProvider)
- Framework detection (read package.json, pubspec.yaml, etc. via GitHub API)
- Project connection with three paths:
  - Path A: .contentrain/ exists → connect immediately
  - Path B: no .contentrain/ → Studio-driven init (via API, conversation in Phase 2)
  - Path C: no repo → demo project for exploration
- Monorepo support (.contentrain/ discovery across subdirectories)
- Content snapshot API (serve .contentrain/ files via Git API)
- Browser: IndexedDB cache, background sync, service worker
- Three-panel layout with sidebar (project list, model list)
- Context panel: read-only content viewer with locale switcher

**Validation:** User signs in with GitHub, connects repo (or explores demo), browses content in browser. Fast (IndexedDB-cached). Works offline for reading.

**Revenue:** None. Foundation for everything.

### Phase 2: Chat Agent + Content Editing ✅ COMPLETED

**What:**
- Content Engine (validate, serialize, branch, commit — all via Git API)
- Smart content_path selection based on detected framework
- Studio-hosted onboarding agent (50 free messages, Haiku-class)
- BYOA key management (encrypted storage, provider selection)
- Chat engine (system prompt with project context, streaming, Studio tool calling)
- Voice input (browser Speech-to-Text API, microphone button in chat)
- Studio agent tools (list_models, get_content, save_content, merge_branch, etc.)
- Guided init conversation for Path B repos (no .contentrain/)
- Post-init consumption guidance (framework-specific: CDN vs SDK vs direct)
- Context panel: inline-editable fields with schema validation
- Branch list with diff viewer, approve/reject
- WebSocket for real-time updates

**Validation:** Non-developer can chat (or speak) with agent to create/edit content, see diff, approve. New repo can be initialized entirely through conversation. Framework detected, content_path set correctly. Developer can review branches and merge. Content round-trips correctly (Studio writes, MCP reads — and vice versa).

**Revenue:** None yet, but core value is deliverable. Free tier is fully functional.

### Phase 3: CDN Content Delivery ✅ COMPLETED

> Full spec: `.internal/CDN-DELIVERY.md`

**What:**
- CDNProvider interface (core) + Cloudflare R2 implementation (EE)
- Event-driven build pipeline: webhook push → selective content build → CDN storage upload
- Content filtering: only published entries, respects publish_at/expire_at
- Document parsing: markdown → frontmatter + body + HTML (build-time)
- Manifest generation (commit sha, models, locales, timestamps)
- CDN API key management (per-project, SHA-256 hashed, plan-gated limits)
- Public CDN API: `/api/cdn/v1/{projectId}/content/{modelId}?locale=en`
- ETag / conditional requests (304 Not Modified)
- Usage metering + rate limiting (EE)
- Webhook enhancement: push event triggers selective CDN rebuild
- Manual rebuild trigger from Studio UI

**EE Separation:**
- Core: CDNProvider interface, cdn-builder, API routes (hasFeature gated), DB schema
- EE: Cloudflare R2 impl, usage metering, rate limiter, advanced config (custom domain, IP allowlist)

**Validation:** Mobile app can fetch content from CDN after merge. Content updates propagate within 30 seconds. Draft content not visible. Free plan returns 403.

**Revenue:** Pro tier unlocked. CDN = first monetization.

### Phase 4: Media Management ✅ COMPLETED

**What (implemented):**
- MediaProvider interface (core) + Sharp processor (EE)
- Upload → optimize → variants → blurhash → R2 storage
- Asset Manager UI (sidebar panel + full-screen modal)
- Agent tools: search_media, upload_media, get_media
- CDN media manifest + __media enrichment
- Context pin + drag-to-chat for assets
- Preview proxy endpoint for Studio UI

### Phase 5 (original): Billing + Advanced Team Features (deferred)

**What:**
- Billing integration (Stripe) — workspace is billing entity
- Tier enforcement (project limits, CDN limits, seat limits per workspace plan)
- Activity log (who did what, when, which model)
- Workspace settings UI (members, plan, billing)

**Note:** Workspace hierarchy, two-tier roles (workspace + project), invitation flow, and RLS-based access control are already implemented in Phase 1.

**Validation:** Billing works. Downgrade blocks new projects beyond tier limit. Activity log shows who changed what.

**Revenue:** Team tier unlocked. Seats = recurring revenue.

### Upcoming Roadmap

| Sprint | Focus | Spec | Plan |
|--------|-------|------|------|
| Next | Project Health (schema validation + dashboard) | `SCHEMA-VALIDATION.md` | Free |
| +1 | Forms & Submissions | `FORMS-SUBMISSIONS.md` | Free+ |
| +2 | Conversation API + Content REST API | `CONVERSATION-API.md` | Business+ |
| +3 | Webhook Outbound | `IDEAS.md` | Business+ |
| +4 | Billing (Stripe) + plan enforcement | — | All |
| +5 | Multi-Provider (GitLab, Bitbucket) | — | Enterprise |

---

## Revenue Model (Revised)

### Pricing Model: Base Plan + Usage-Based

> Updated 2026-03-26 — aligned with implemented features

Plans unlock features. Usage beyond included amounts = overage billing (Stripe metering).
BYOA (bring your own API key) is available on ALL plans including Free.

### Pricing Tiers

| | Free ($0) | Pro ($9/mo) | Team ($29/mo + $7/seat) | Enterprise (custom) |
|---|---|---|---|---|
| Workspaces | ∞ | ∞ | ∞ | ∞ |
| Projects | ∞ | ∞ | ∞ | ∞ |
| Users | 2 | 10 | 50 | ∞ |
| AI Chat (included) | 50 msg/mo | 500 msg/mo | 2,000 msg/mo | Custom |
| BYOA | ✅ ∞ | ✅ ∞ | ✅ ∞ | ✅ ∞ |
| CDN | — | ✅ (10 GB) | ✅ (50 GB) | ✅ (∞) |
| Media | — | ✅ (2 GB) | ✅ (10 GB) | ✅ (∞) |
| Forms | 1 form, 50 sub | 5 forms, 500 sub | ∞, 5K sub | ∞ |
| Review workflow | — | ✅ | ✅ | ✅ |
| Conversation API | — | — | ✅ (1K msg) | ✅ |
| REST API | — | — | ✅ | ✅ |
| Webhooks | — | — | ✅ | ✅ |
| SSO / White-label | — | — | — | ✅ |

### Usage-Based Overage (Pro+)

| Resource | Included | Overage |
|----------|----------|---------|
| AI messages | Per plan | $0.02/msg |
| CDN bandwidth | Per plan | $0.10/GB |
| Media storage | Per plan | $0.25/GB/mo |
| Form submissions | Per plan | $0.01/sub |
| API messages | Per plan (Team+) | $0.05/msg |

### Upgrade Triggers

| Free → Pro | Pro → Team |
|------------|------------|
| Needs CDN (app goes live) | Needs Conversation API (bot integration) |
| Needs Media (images) | Needs 10+ users |
| Needs review workflow | Needs webhooks (CI/CD) |
| 50 AI msg limit hit | Needs REST API |
| 5+ forms needed | Model-scoped access control |

### Target Audience

**Primary:** Solo developer / small agency (1-5 people) building with Next.js, Nuxt, Astro, React Native, Flutter.
Includes vibe coders using AI (Cursor/Windsurf) to build apps — Contentrain manages the content layer.

**Secondary:** Startup product teams (5-20 people) managing marketing + docs + blog.

**Message:** "Your AI builds the app. Contentrain manages the content."

### Revenue Projections (6 months post-launch)

| Metric | Target |
|---|---|
| Free signups | 500 |
| Free → Pro conversion | 15% (75 Pro) |
| Pro → Team conversion | 12% (9 Teams) |
| Average Team size | 3 seats |
| Pro MRR | 75 × $9 = $675 |
| Team MRR | 9 × ($29 + 2 × $7) = $387 |
| Usage overage MRR | ~$300 |
| **Total MRR** | **~$1,360** |

Month 12 target with growth: $5,000+ MRR.

---

## Data Model

### Workspace Hierarchy

```
User (profile)
  └── Workspace (billing entity, team boundary)
        ├── Workspace Members (owner / admin / member)
        ├── GitHub Installation (workspace seviyesinde)
        └── Projects (connected repos)
              └── Project Members (editor / reviewer / viewer + specificModels)
```

- Signup auto-creates personal workspace (type: primary)
- Workspace Owner/Admin → implicit access to all projects
- Workspace Member → needs explicit project assignment
- GitHub App installation lives on workspace (covers all repos)

### What's in Studio's Database

```
profiles (extends auth.users)
workspaces (billing entity — name, slug, plan, github_installation_id)
workspace_members (workspace-level roles: owner, admin, member)
projects (workspace_id, repo connection)
project_members (project-level roles: editor, reviewer, viewer + specificModels)
api_keys (BYOA, encrypted)
conversations + messages
activity_log
cdn_api_keys + cdn_builds + cdn_usage (Phase 3)
media_assets + media_usage (Phase 3.5–5 — metadata in DB, files in R2)
billing (Stripe customer/subscription references)
```

### What's NOT in Studio's Database

**Content.** Content lives in Git. Studio reads it via Git Provider API, caches it in browser IndexedDB. Studio's database has zero content data. This is fundamental:

- Git = source of truth for content
- Studio DB = source of truth for users, teams, billing, activity
- Browser IndexedDB = cache for fast UI

### Monorepo Support

```
projects table:
  github_repo: "my-org/platform"
  content_root: "apps/web"          ← where .contentrain/ lives
```

Same repo can have multiple Studio projects, each pointing to a different `content_root`. Discovery happens during project connection: Studio scans the repo tree for `.contentrain/config.json` files and lets the user choose.

---

## Security

### BYOA Key Management

- User's AI provider API key encrypted with AES-256-GCM
- Encryption key in environment variable, not database
- Key decrypted only in-memory during API call, never logged
- User can rotate/delete key anytime

### Git Access

- GitHub App installation token for all Git operations
- Scoped to `.contentrain/` path (conceptually — App has repo access but Studio only reads/writes .contentrain/)
- Push commits attributed to "Contentrain Studio[bot]"
- Co-Authored-By trailer identifies the actual user
- Branch protection rules respected (create PR if required)

### CDN Access

- Per-project API key (Bearer token)
- Rate limiting per key
- CORS configurable per project
- No authentication required for public projects (optional setting)

---

## Integration Points

### Between Monorepo and Studio

```
Developer works locally:
  npx contentrain init → creates .contentrain/
  Agent creates models → .contentrain/models/*.json
  Agent saves content → .contentrain/content/**/*.json
  git push → content in GitHub

Studio:
  Reads .contentrain/ from GitHub → shows in UI
  User edits in Studio → commits via GitHub API → git pull locally

Round-trip is Git. No direct communication needed.
```

### Format Guarantee

CI test (in monorepo):
```
1. Create content with MCP (locally)
2. Read the same content with Studio's Content Engine logic
3. Assert: identical parsing
4. Create content with Studio's Content Engine logic
5. Read with MCP
6. Assert: identical parsing
```

This test imports `@contentrain/types` validation/serialization utilities and verifies both sides produce identical output.

---

## Competitive Position (Revised)

Studio's independence makes the competitive picture clearer:

| | Studio | Sanity | Contentful | Tina |
|---|---|---|---|---|
| **Storage** | Git (user's repo) | Proprietary DB | Proprietary DB | Git |
| **AI interface** | Chat-first (BYOA) | Bolt-on AI | Bolt-on AI | None |
| **Content delivery** | CDN + Git files | API | API | Git files |
| **Media** | Upload + optimize + CDN | Built-in | Built-in | None |
| **Pricing model** | Seats + CDN bandwidth | Seats + API calls | Seats + API calls | Free + Pro |
| **Vendor lock-in** | Zero (Git files) | High (proprietary) | High (proprietary) | Low (Git) |
| **Non-dev editing** | Chat + inline | Forms | Forms | Forms |
| **Self-host** | AGPL (free) | No | No | No |
| **i18n** | Native (per-locale files) | Plugin | Plugin | Limited |

**Studio's moat:** Chat-first + Git-native + BYOA + zero lock-in. No existing product combines these. Competitors would need to abandon their database architecture to match Git-native, and abandon their form UI to match chat-first.

---

## Success Metrics (Revised)

### North Star: Weekly Active Reviews (WAR)

Content branches reviewed (approved or rejected) per week. This measures the core value: team governance.

### Supporting Metrics

| Metric | What It Tells You | Warning Signal |
|---|---|---|
| **WAR** | Governance adoption | < 50/week at month 3 |
| Chat messages/week | Agent usefulness | < 5/user/week |
| Inline edits/week | Quick-edit value | If >> chat, chat is failing |
| CDN requests/month | Delivery adoption | Flat after month 3 |
| Media uploads/month | Media feature value | < 10/month after launch |
| Free → Pro conversion | Value gap correctness | < 8% |
| Seat expansion rate | Team growth | Teams stuck at 2 seats |
| Time to first review | Onboarding health | > 1 hour from signup |
| Content round-trip test | Format integrity | Any failure = critical bug |

### Early Warning Signals

- Chat abandoned mid-conversation > 30%: agent prompt or UX problem
- Users connect repo but never browse: IndexedDB sync or UI problem
- Branches pile up > 10 unreviewed: review isn't part of workflow
- CDN enabled but < 100 req/month: setup too hard or not needed
- Media uploaded but never used in content: workflow disconnect

---

## Key Decisions Summary

| Decision | Choice | Rationale |
|---|---|---|
| MCP dependency | None. Shared standard only (types/rules). | Studio is independent product, not MCP wrapper. |
| Git operations | Provider API, not clone | No disk, stateless server, multi-provider ready. |
| Primary UI | Conversation-first (chat + voice) | Consistent with "agent generates" philosophy. Forms never. |
| AI billing | Studio-hosted + BYOA option | Hosted agent removes onboarding friction. BYOA for power users. |
| Browser storage | IndexedDB + background sync | Offline support, instant UI, reduced server load. |
| Server state | Stateless (no disk, no clone) | Horizontal scaling trivial, lower ops cost. |
| Auth | GitHub App (v1), multi-provider later | Fine-grained permissions, org-level install, bot attribution. |
| Content DB | None. Git is the database. | Single source of truth, no sync problem. |
| Format safety | Shared @contentrain/types utilities | Prevents drift between MCP and Studio. |
| Media | Object storage + processing pipeline | Real infrastructure cost = natural revenue. |
| Phase order | Browse → Chat+Edit → CDN → Teams → Media → Advanced | Value before revenue, foundation before features. |

---

## Phase Timeline Summary

| Phase | Duration | Delivers | Revenue |
|---|---|---|---|
| 1. Foundation + Browse | 2 weeks | Auth, project connection, content browsing, IndexedDB cache | — |
| 2. Chat + Edit + Review | 3 weeks | Agent chat, content editing, branch review, real-time updates | Free tier live |
| 3. CDN | 2 weeks | Content delivery for non-web platforms | Pro tier ($14/mo) |
| 3.5–5. Media | 2-3 weeks | Image upload, optimization, variants, asset manager, agent media tools | Storage billing |
| 4. Teams + Billing | 2 weeks | Roles, invitations, billing | Team tier ($34+/mo) |
| 6. Advanced | 2-3 weeks | Scheduling, versioning, translation memory, analytics | Feature justification |
| 7. Multi-Provider | 2 weeks | GitLab, Bitbucket | Enterprise |

**Total to revenue (Phase 1-3):** ~7 weeks.
**Total to team revenue (Phase 1-4):** ~9 weeks.
**Total to full v1 (Phase 1-6):** ~14 weeks.

---

## What Studio Is, Revised

Contentrain Studio is where structured content meets the rest of the team. Developers structure content locally with AI agents and Contentrain's open-source tools — Studio is where that content gets browsed, edited, reviewed, translated, and delivered.

Chat-first: tell the agent what you want. Visual when you need it: browse, quick-edit, review diffs. Git-native: every change is a commit, every review is a branch merge. Platform-independent: CDN delivers the same JSON content to web, mobile, desktop, and anything else.

No vendor lock-in. No AI fees. Your content stays in your Git repo as plain JSON files — whether you use Studio or not.

---

# Technical Architecture

Everything below describes **how** to build the product described above. Tech stack choices are open — the patterns and contracts matter.

---

## System Components

```
┌─────────────────────────────────────────────────────────────────┐
│  BROWSER (SPA)                                                  │
│  ┌───────────┐  ┌──────────────┐  ┌─────────────────────────┐ │
│  │ IndexedDB │  │ Chat + Voice │  │ Context Panel           │ │
│  │ (snapshot  │  │ Panel        │  │ (content viewer,        │ │
│  │  cache)    │  │              │  │  inline editor,         │ │
│  └─────┬──────┘  └──────┬───────┘  │  diff viewer,          │ │
│        │                │          │  branch reviewer)       │ │
│  ┌─────▼────────────────▼──────┐   └─────────────────────────┘ │
│  │ Service Worker              │                                │
│  │ - background delta sync     │                                │
│  │ - offline write queue       │                                │
│  │ - push notification handler │                                │
│  └──────────────┬──────────────┘                                │
└─────────────────┼───────────────────────────────────────────────┘
                  │ HTTPS + SSE (chat) + WebSocket (real-time)
                  ▼
┌─────────────────────────────────────────────────────────────────┐
│  SERVER (stateless — no disk, no clone)                         │
│                                                                 │
│  ┌─────────────┐  ┌─────────────┐  ┌────────────────────────┐ │
│  │ Auth Module │  │ Chat Engine │  │ Content Engine         │ │
│  │             │  │             │  │                        │ │
│  │ GitHub App  │  │ BYOA proxy  │  │ Read: Git API → parse  │ │
│  │ OAuth flow  │  │ + hosted    │  │ Write: validate →      │ │
│  │ Session mgmt│  │   agent     │  │   serialize → branch   │ │
│  │             │  │ SSE stream  │  │   → commit → Git API   │ │
│  │             │  │ Tool calls  │  │ Merge: Git API merge   │ │
│  └──────┬──────┘  └──────┬──────┘  │   or create PR         │ │
│         │               │         └───────────┬────────────┘ │
│         │          ┌────▼─────────────────────▼──────────┐   │
│         │          │  ContentProvider (abstraction)       │   │
│         │          └────────────────┬────────────────────┘   │
│         │                          │                         │
│  ┌──────▼──────┐  ┌───────────────▼────────────────────┐   │
│  │ Team/Billing│  │ CDN Publisher                       │   │
│  │ Module      │  │ merge hook → export → object store  │   │
│  └─────────────┘  └────────────────────────────────────┘   │
│                                                             │
│  ┌─────────────────────────────────────────────────────┐   │
│  │ Framework Detector                                   │   │
│  │ reads repo tree → detects stack → suggests paths     │   │
│  └─────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
         │                    │                    │
         ▼                    ▼                    ▼
┌──────────────┐  ┌───────────────────┐  ┌──────────────┐
│ GitHub App   │  │ AI Provider       │  │ Object Store │
│ (install,    │  │ (Anthropic,       │  │ (R2/S3)      │
│  OAuth,      │  │  OpenAI — user's  │  │ + CDN Edge   │
│  Git API)    │  │  key or Studio's) │  │              │
└──────────────┘  └───────────────────┘  └──────────────┘
```

## Content Engine (Core)

Studio's own content management layer. Shares `@contentrain/types` and `@contentrain/rules` with the monorepo, but has its own implementation.

### Read Path

```
Browser requests content →
  Server: ContentProvider.getTree('.contentrain/') →
  Parse config.json, models/*.json, content/**/*.json →
  Return structured snapshot →
  Browser stores in IndexedDB
```

### Write Path

```
User (chat or inline edit) triggers content change →
  Content Engine receives: { model, locale, data } →
  Step 1: Load model schema from Git (ContentProvider.readFile)
  Step 2: Validate data against schema (@contentrain/types validators)
  Step 3: Apply quality rules (@contentrain/rules)
  Step 4: Serialize to canonical JSON (@contentrain/types serializer)
  Step 5: Create branch (ContentProvider.createBranch)
  Step 6: Commit file (ContentProvider.commitFiles)
  Step 7: Return diff + branch info to client
  Step 8: User approves → ContentProvider.mergeBranch (or createPR)
```

**Hard validation guarantee:** Step 2-3 NEVER skip. Invalid content is rejected with specific error messages before it touches Git.

### Snapshot & Delta Sync

```
GET /api/projects/{id}/snapshot
→ Returns all .contentrain/ files as single JSON payload
→ Browser stores in IndexedDB, renders UI

GET /api/projects/{id}/snapshot/delta?since={commit_sha}
→ Returns only files changed since that commit
→ Browser patches IndexedDB, UI reactively updates

Strategy:
  - First visit: full snapshot (~700KB typical project)
  - Subsequent visits: delta only (usually <10KB)
  - WebSocket event triggers delta refresh
  - Offline: IndexedDB serves, writes queue for sync
```

## Chat Engine

### System Prompt Construction

For every chat session, dynamically built from project state:

```
System prompt =
  1. Studio agent role definition
     "You are a content management assistant..."

  2. Project context (from latest snapshot)
     - config: { stack, locales, domains, workflow }
     - models: [{ id, kind, fields summary }]
     - recent activity: last 5 operations

  3. Content quality rules (from @contentrain/rules)
     - Relevant subset based on detected intent

  4. Studio tool definitions (JSON Schema)
     - list_models, get_content, save_content, etc.

  5. Framework-specific guidance
     - If Nuxt detected: "content_path should use content/ convention"
     - If mobile: "recommend CDN for content delivery"
```

### Studio Agent Tools

| Tool | Input | What It Does | Output |
|---|---|---|---|
| `list_models` | — | Lists all models with field schemas | Model[] |
| `get_content` | model, locale | Reads content entries | entries[] |
| `save_content` | model, locale, data | Validates → branch → commit | { branch, diff } |
| `delete_content` | model, locale, ids | Removes entries | { branch, diff } |
| `save_model` | model definition | Creates/updates model schema | { branch, diff } |
| `validate` | model? | Validates content against schemas | ValidationResult |
| `list_branches` | — | Shows pending contentrain/* branches | Branch[] |
| `merge_branch` | branch name | Merges branch (or creates PR) | MergeResult |
| `reject_branch` | branch name | Closes/deletes branch | void |
| `copy_locale` | model, from, to | Bulk copies content to new locale | { branch, diff } |
| `init_project` | stack, locales, domains | Creates .contentrain/ structure | { branch, diff } |
| `detect_framework` | — | Reads repo, detects stack | { stack, suggestions } |

Every tool calls the Content Engine internally. The agent never writes to Git directly.

### Streaming Architecture

```
Client → POST /api/projects/{id}/chat
  Body: { message, conversation_id? }
  Response: SSE stream

Server:
  1. Load/create conversation
  2. Build system prompt
  3. Call AI provider with messages + tools
  4. Stream response tokens via SSE
  5. On tool_use: execute tool synchronously, return result to provider
  6. Continue streaming until done
  7. Save messages to DB
```

### Hosted Agent vs BYOA

```
If user has BYOA key configured:
  → Use user's key + user's chosen model
  → No message limit

If user on Pro/Team without BYOA:
  → Use Studio's key + tier-appropriate model (Sonnet for Pro/Team)
  → Monthly message limit enforced

If user on Free without BYOA:
  → Use Studio's key + Haiku (cheapest)
  → 50 lifetime messages
  → After 50: "Add your API key or upgrade to Pro"
```

## Git Provider Abstraction

```
interface ContentProvider {
  // Tree operations (scoped to content_root + .contentrain/)
  getTree(ref?: string): Promise<TreeEntry[]>
  readFile(path: string, ref?: string): Promise<string>
  listDirectory(path: string, ref?: string): Promise<string[]>

  // Write operations
  createBranch(name: string, fromRef?: string): Promise<void>
  commitFiles(branch: string, files: FileChange[], message: string, author: CommitAuthor): Promise<Commit>

  // Branch management
  listBranches(prefix?: string): Promise<Branch[]>
  getBranchDiff(branch: string, base?: string): Promise<FileDiff[]>
  mergeBranch(branch: string, into: string): Promise<MergeResult>
  deleteBranch(branch: string): Promise<void>

  // PR (when branch protection requires it)
  createPR(head: string, base: string, title: string, body: string): Promise<PR>
  mergePR(id: string): Promise<void>

  // Permissions & config
  getPermissions(): Promise<RepoPermissions>
  getBranchProtection(branch: string): Promise<BranchProtection | null>
  getDefaultBranch(): Promise<string>

  // Detection
  fileExists(path: string, ref?: string): Promise<boolean>
  detectFramework(): Promise<FrameworkDetection>
}

interface FrameworkDetection {
  stack: string            // "nuxt", "next", "astro", "flutter", "unknown"
  hasContentDir: boolean   // content/ or src/content/ exists
  hasI18n: boolean         // i18n config detected
  suggestedContentPaths: Record<string, string>  // model kind → path suggestion
}
```

**Implementations:**
- `GitHubAppProvider` — v1, uses GitHub App installation tokens + REST/GraphQL
- `GitLabProvider` — v2, uses GitLab API
- `BitbucketProvider` — v3, uses Bitbucket API

### Commit Attribution

All commits via Studio:
```
Author: Contentrain Studio[bot] <studio@contentrain.io>
Co-Authored-By: editor-name <editor@company.com>
```

Git blame shows the bot as author, co-author trailer identifies the real person. This works with GitHub App tokens and doesn't require the user to have repo push access.

## Browser Architecture

### IndexedDB Schema

```
contentrain_db:
  stores:
    snapshots:
      key: project_id
      value: {
        commit_sha: string
        synced_at: timestamp
        files: {
          [path: string]: {
            content: string
            sha: string
          }
        }
      }

    pending_writes:
      key: auto-increment
      value: {
        project_id: string
        operation: "save_content" | "save_model" | ...
        payload: object
        created_at: timestamp
        status: "pending" | "syncing" | "failed"
      }

    conversations:
      key: conversation_id
      value: {
        project_id: string
        messages: Message[]
        updated_at: timestamp
      }
```

### Service Worker

```
Responsibilities:
  1. Background delta sync (periodic + event-triggered)
  2. Offline write queue (pending_writes → API when online)
  3. Push notification handler (new branch, review requested)
  4. Cache static assets (SPA shell, fonts, icons)

NOT responsible for:
  - Chat streaming (SSE handled by main thread)
  - WebSocket connection (main thread)
```

### Three-Panel Responsive Layout

```
Desktop (>1280px):
  [Sidebar 240px] [Chat flex-1 min-400px] [Context 400px]

Tablet (768-1280px):
  [Sidebar icons 56px] [Chat flex-1] [Context 360px]

Mobile (<768px):
  [Full-width single panel with bottom tab navigation]
  Tabs: Chat | Content | Branches | Settings
```

### Context Panel Reactive States

The context panel shows different content based on current activity:

```
State machine:
  IDLE          → Project overview (stats, recent activity)
  MODEL_FOCUS   → Model content viewer (inline-editable fields)
  BRANCH_FOCUS  → Branch diff viewer (before/after + approve/reject)
  VALIDATION    → Validation results (errors/warnings list)
  INIT_GUIDE    → Framework detection results + setup guidance
  MEDIA_BROWSE  → Media library (grid of uploaded assets)
```

Transitions triggered by:
- Chat context (agent mentions a model → MODEL_FOCUS)
- Sidebar click (click branch → BRANCH_FOCUS)
- Agent action (validation run → VALIDATION)

## CDN Publisher

### Pipeline

```
Trigger: GitHub webhook (push to default branch) or manual

Steps:
  1. ContentProvider.getTree() → read all .contentrain/ files
  2. For each model with CDN-eligible content:
     - Parse content files
     - Validate (reject if invalid — don't publish broken content)
     - Serialize to clean JSON
     - Upload to object storage:
       /{project-id}/{model-id}/{locale}.json
       /{project-id}/{model-id}/{entry-slug}.json (documents)
  3. Generate manifest:
     /{project-id}/manifest.json
  4. Invalidate CDN cache for changed paths
  5. Log publish event to activity_log
```

### CDN Endpoints

```
Public (requires project API key):
  GET cdn.contentrain.io/{project-id}/manifest.json
  GET cdn.contentrain.io/{project-id}/{model}/{locale}.json

Headers:
  Authorization: Bearer {cdn-api-key}
  — or —
  ?key={cdn-api-key}

Response headers:
  Cache-Control: public, max-age=60, stale-while-revalidate=3600
  ETag: "{content-hash}"
  Content-Type: application/json; charset=utf-8
  Access-Control-Allow-Origin: {configured-origins}
```

### Manifest Format

```json
{
  "version": 1,
  "project": "my-saas",
  "updated_at": "2026-03-17T12:00:00Z",
  "models": [
    {
      "id": "hero-section",
      "kind": "singleton",
      "locales": ["en", "tr"],
      "updated_at": "2026-03-17T12:00:00Z",
      "endpoints": {
        "en": "/hero-section/en.json",
        "tr": "/hero-section/tr.json"
      }
    }
  ]
}
```

## Database Schema

```sql
-- Auth
users (
  id uuid PK,
  github_id bigint UNIQUE,
  github_login text,
  email text,
  avatar_url text,
  created_at timestamp,
  last_login_at timestamp
)

-- Projects
projects (
  id uuid PK,
  owner_id uuid FK → users,
  provider text,  -- "github" | "gitlab" | "bitbucket"
  repo_full_name text,  -- "org/repo"
  default_branch text,
  content_root text,  -- "/" or "apps/web/" for monorepos
  detected_stack text,  -- "nuxt" | "next" | "flutter" | "unknown"
  cdn_enabled boolean DEFAULT false,
  cdn_api_key_hash text,
  status text,  -- "active" | "setup" | "error"
  created_at timestamp
)

project_members (
  project_id uuid FK → projects,
  user_id uuid FK → users,
  role text,  -- "owner" | "editor" | "reviewer" | "viewer"
  invited_by uuid FK → users,
  invited_at timestamp,
  accepted_at timestamp,
  PRIMARY KEY (project_id, user_id)
)

-- AI Keys
ai_keys (
  id uuid PK,
  user_id uuid FK → users,
  provider text,  -- "anthropic" | "openai"
  encrypted_key text,  -- AES-256-GCM
  created_at timestamp
)

-- Chat
conversations (
  id uuid PK,
  project_id uuid FK → projects,
  user_id uuid FK → users,
  created_at timestamp,
  updated_at timestamp
)

messages (
  id uuid PK,
  conversation_id uuid FK → conversations,
  role text,  -- "user" | "assistant" | "tool_result"
  content text,
  tool_calls jsonb,
  tokens_used integer,
  model_used text,  -- "haiku" | "sonnet" | user's model
  created_at timestamp
)

-- Activity & billing
activity_log (
  id uuid PK,
  project_id uuid FK → projects,
  user_id uuid FK → users,
  action text,
  details jsonb,
  created_at timestamp
)

cdn_usage (
  project_id uuid FK → projects,
  month date,
  requests bigint DEFAULT 0,
  bandwidth_bytes bigint DEFAULT 0,
  PRIMARY KEY (project_id, month)
)

media_assets (
  id uuid PK,
  project_id uuid FK → projects,
  uploaded_by uuid FK → users,
  filename text,
  content_type text,
  size_bytes bigint,
  storage_path text,  -- path in object store
  variants jsonb,  -- { "thumb": "path", "card": "path", ... }
  created_at timestamp
)

billing_subscriptions (
  id uuid PK,
  user_id uuid FK → users,
  stripe_customer_id text,
  stripe_subscription_id text,
  tier text,  -- "free" | "pro" | "team" | "enterprise"
  status text,  -- "active" | "past_due" | "canceled"
  current_period_end timestamp
)

-- Agent usage tracking
agent_usage (
  user_id uuid FK → users,
  month date,
  hosted_messages integer DEFAULT 0,
  hosted_tokens integer DEFAULT 0,
  PRIMARY KEY (user_id, month)
)
```

**Content is NOT in this database.** Content lives in Git, cached in browser IndexedDB.

## Real-Time Events (WebSocket)

```
Client connects: WS /ws?project={id}&token={session}

Server → Client events:
  { type: "branch:created", data: { name, author, created_at } }
  { type: "branch:merged", data: { name, merged_by } }
  { type: "branch:rejected", data: { name, rejected_by } }
  { type: "content:updated", data: { model, locale, commit_sha } }
  { type: "member:joined", data: { user, role } }
  { type: "cdn:published", data: { models, timestamp } }

Client → Server (rare):
  { type: "typing", data: { user_id } }  // for collaborative presence
```

## API Endpoints Summary

```
Auth:
  GET  /auth/github/install     → GitHub App installation redirect
  GET  /auth/github/callback    → exchange code, create session
  POST /auth/logout
  GET  /auth/me

Projects:
  GET    /projects
  POST   /projects              → connect repo, detect framework
  GET    /projects/:id
  DELETE /projects/:id
  GET    /projects/:id/snapshot          → full .contentrain/ snapshot
  GET    /projects/:id/snapshot/delta    → changed files since sha
  GET    /projects/:id/branches
  POST   /projects/:id/branches/:name/merge
  POST   /projects/:id/branches/:name/reject

Content (via Content Engine):
  GET    /projects/:id/models
  GET    /projects/:id/content/:model?locale=en
  POST   /projects/:id/content/:model    → validate + branch + commit
  PUT    /projects/:id/content/:model/:entry
  DELETE /projects/:id/content/:model/:entry

Chat:
  POST   /projects/:id/chat              → SSE stream
  GET    /projects/:id/conversations
  GET    /projects/:id/conversations/:cid

Team:
  GET    /projects/:id/members
  POST   /projects/:id/members           → invite
  PATCH  /projects/:id/members/:uid      → change role
  DELETE /projects/:id/members/:uid

CDN:
  POST   /projects/:id/cdn/enable
  POST   /projects/:id/cdn/publish       → manual trigger
  GET    /projects/:id/cdn/usage

AI Keys:
  GET    /ai-keys
  POST   /ai-keys                        → store encrypted key
  DELETE /ai-keys/:id

Media:
  POST   /projects/:id/media/upload
  GET    /projects/:id/media
  DELETE /projects/:id/media/:id

CDN Public (separate domain):
  GET    cdn.contentrain.io/:project/manifest.json
  GET    cdn.contentrain.io/:project/:model/:locale.json

Billing:
  GET    /billing
  POST   /billing/checkout               → Stripe checkout session
  POST   /billing/portal                 → Stripe customer portal
```

## Deployment

### Single Server (Launch)

```
Server process (stateless):
  - API endpoints
  - Chat engine (SSE)
  - WebSocket server
  - CDN publisher (webhook handler)
  - No local storage, no Git clones

External services:
  - Database (PostgreSQL or SQLite)
  - Object storage (R2/S3) for CDN + media
  - GitHub API
  - AI provider API (Anthropic/OpenAI)
```

### Docker (Self-Host)

```yaml
services:
  studio:
    image: contentrain/studio:latest
    ports: ["3000:3000"]
    environment:
      DATABASE_URL: postgres://...
      GITHUB_APP_ID: "..."
      GITHUB_APP_PRIVATE_KEY: "..."
      ENCRYPTION_KEY: "..."
      CDN_STORAGE_URL: "..."
    volumes:
      - studio-data:/data  # only for SQLite mode
```

### Scaled

```
Multiple API instances (stateless) →
  Shared PostgreSQL →
  Shared object storage →
  Load balancer (sticky sessions for WebSocket)
```

Stateless server = horizontal scaling is adding instances. No shared disk, no clone management, no worktree cleanup.

## Dependency Map

```
Studio depends on:
  @contentrain/types  — file format standard, validation, serialization
  @contentrain/rules  — content quality rules, system prompt material
  GitHub API          — Git operations, OAuth
  AI Provider API     — chat (Anthropic, OpenAI — user or Studio key)
  Object Storage      — CDN content + media assets
  Database            — users, projects, conversations, billing
  Stripe              — billing

Studio does NOT depend on:
  @contentrain/mcp    — Studio has its own Content Engine
  @contentrain/query  — end-user SDK, not Studio's concern
  @contentrain/skills — optional, may inform agent prompts
  contentrain CLI     — Studio has its own UI
  Git binary          — all Git via API, no local git needed
  Node.js filesystem  — stateless, no disk operations
```

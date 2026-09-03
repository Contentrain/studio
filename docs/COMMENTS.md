# Comments v1

Studio-managed comments for content entries: the runtime half of the "comments"
capability a site loses when it leaves WordPress for a static build. Comments
live in the Studio database — never in Git — and are served to any site through
a small public API. Per-model configuration lives on the model definition next
to `form`, so it travels with the repository like every other content rule.

```
visitor ──► public API (/api/comments/v1)  ──► comments table ──► moderation (Studio UI / agent / API)
                                                    ▲
WordPress export (contentrain-comments@1) ── import ┘
```

## Enabling comments on a model

`PATCH /api/workspaces/{workspaceId}/projects/{projectId}/models/{modelId}` with a
`comments` block (workspace owner/admin; plan feature `comments.enabled`,
`comments.models` cap). Collections and documents only.

| key | default | meaning |
|---|---|---|
| `enabled` | `false` | Accept comments on this model's entries |
| `requireApproval` | `true` | New comments start `pending`; `false` publishes immediately (needs `comments.auto_approve`) |
| `maxDepth` | `4` | Reply nesting cap for **new** public submissions (`0` = flat). Import never clamps |
| `requireEmail` | `true` | Commenters must supply an email; it is never shown publicly |
| `honeypot` | `true` | Hidden `_hp` field; a filled honeypot is silently accepted and dropped |
| `captcha` | `null` | `'turnstile'` to require a Cloudflare Turnstile token (needs `comments.captcha` + `NUXT_TURNSTILE_SECRET_KEY`) |
| `rateLimitPerIp` | `5` | Submissions per IP per minute on one entry |
| `maxBodyLength` | `5000` | Body length cap for public submissions |

The same block is editable from the model's **Comments Settings** tab in Studio.

## Public API (no auth, CORS `*`)

Both routes are exempt from the session middleware and answered by the
`00.public-cors` middleware for `OPTIONS` preflight. Rate limits are per IP.

### Read a thread

```
GET /api/comments/v1/{projectId}/{modelId}/{entryId}?locale=en&page=1&limit=20&sort=oldest
```

```jsonc
{
  "entry": { "modelId": "posts", "entryId": "…", "locale": "en" },
  "config": {
    "closed": false,            // thread closed → render comments, hide the form
    "requireApproval": true,
    "requireEmail": true,
    "maxDepth": 4,
    "maxBodyLength": 5000,
    "captcha": "turnstile" | null,
    "captchaSiteKey": "0x4AAA…" | null,   // NUXT_PUBLIC_TURNSTILE_SITE_KEY
    "honeypotField": "_hp" | null
  },
  "comments": [
    {
      "id": "uuid", "parentId": null, "depth": 0,
      "author": { "name": "Ada", "url": "https://ada.dev/", "isModerator": false },
      "body": "plain text", "type": "comment", "createdAt": "2020-05-01T10:00:00.000Z",
      "replies": [ /* same shape, nested */ ]
    }
  ],
  "total": 42, "page": 1, "limit": 20
}
```

- Pagination is over **root** comments; every approved reply under the page's
  roots ships nested inside them (up to 500 per page).
- Only `approved` comments are returned. A reply whose parent is not approved
  is not shown — moderating a comment out hides its branch.
- Never returned: email, IP address, user agent, referrer. There is no avatar
  hash either (a hashed email is still rainbow-tableable).
- `body` is plain text; render it escaped.

### Submit a comment

```
POST /api/comments/v1/{projectId}/{modelId}/{entryId}?locale=en
Content-Type: application/json

{ "author": { "name": "Ada", "email": "ada@example.com", "url": "https://ada.dev" },
  "body": "…", "parentId": "uuid | omit", "captchaToken": "…", "_hp": "" }
```

| response | meaning |
|---|---|
| `200 { success: true, status: 'pending' \| 'approved', comment }` | Stored. `approved` renders now; `pending` is only echoed to its author |
| `200 { success: false, errors: [{ field, message }] }` | Validation: `author.name`, `author.email`, `author.url`, `body`, `parentId` (missing / not approved / too deep), `captcha` |
| `403` | Thread closed for this entry, or plan lacks `comments.enabled` |
| `404` | Unknown project/model, or comments disabled on the model |
| `429` | Per-IP rate limit, or the workspace's monthly `comments.per_month` quota |

Quota, parent resolution, depth check and the insert run atomically inside one
database function (`create_comment_if_allowed`) under a per-workspace lock.
Only public submissions count toward the monthly quota — imports and
moderator replies do not.

## Moderation

Studio: the model's **Comments** tab (pending / approved / spam / rejected
filters, bulk actions, detail modal with moderator reply and thread open/close).
Agent tools: `list_comments`, `approve_comment`, `reject_comment` (`spam: true`
for spam), `reply_comment`. API (session auth, workspace roles):

| route | role | body |
|---|---|---|
| `GET /api/workspaces/{ws}/projects/{p}/comments?status&modelId&entryId&locale&page&limit&sort` | member+ (members need a project assignment) | — returns `{ comments, total, counts }` |
| `PATCH …/comments/{id}` | owner/admin | `{ status: 'approved' \| 'rejected' \| 'spam' \| 'pending' }` |
| `DELETE …/comments/{id}` | owner/admin | — replies cascade; audit-logged |
| `POST …/comments/{id}/reply` | owner/admin | `{ body }` — published immediately; a pending parent is approved first |
| `POST …/comments/bulk` | owner/admin | `{ action: 'approve' \| 'reject' \| 'spam' \| 'pending' \| 'delete', commentIds: [≤50] }` |
| `PATCH …/comments/threads/{modelId}/{entryId}` | owner/admin | `{ closed: boolean, locale? }` |
| `POST …/comments/import` | owner/admin | a `CommentsExport` (below) |

Webhook events (plan feature `comments.webhook_notification`, ee):
`comment.submitted` on every public submission, `comment.approved` when a
comment becomes public.

## WordPress import (`contentrain-comments@1`)

`@contentrain/wp-import` (and the CLI: `npx contentrain import <export.xml | https://site> --out <dir>`,
optional `--auth user:app-password`) produces a `CommentsExport` as `comments-export.json` next to the
`.contentrain` store it writes, together with `entry-source-map.json` and `import-report.json`. The type lives in
`@contentrain/types`:

```jsonc
{
  "version": 1,
  "format": "contentrain-comments@1",
  "source": { … },                       // RawProvenance
  "generated_at": "2026-01-10T00:00:00Z",
  "entries": { "1234": { "model_id": "posts", "entry_id": "…", "locale": "en" } },   // WP post id → entry
  "threads_closed": [ 1234 ],            // posts whose comment form was closed
  "comments": [ /* RawComment[] — verbatim WordPress rows */ ]
}
```

`POST /api/workspaces/{ws}/projects/{p}/comments/import?locale=en` (plan feature
`comments.import`; ≤ 5 000 comments per request — chunk larger exports).

```jsonc
{
  "received": 3, "mapped": 2, "inserted": 2, "skippedExisting": 0,
  "unmapped": [{ "comment_id": 9, "post": 77 }],   // post has no entry mapping — reported, never dropped
  "orphanCount": 0, "orphanParents": [],           // parent id that resolved to nothing (yet)
  "maxDepth": 3, "threadsClosed": 1, "datesDefaulted": 0
}
```

Fidelity rules (the S-08 acceptance criterion is *zero record and zero parent loss*):

- Every comment whose post maps to an entry is inserted with its source
  timestamp (`date`, else `date_gmt`, else the export's `generated_at` — counted
  in `datesDefaulted`), status (`1` → approved, `0` → pending, `spam` → spam,
  `trash` → rejected, anything else → pending), type (pingback/trackback kept)
  and parent link. Depth is **never clamped**; `maxDepth` only gates new
  public submissions.
- Parents are linked by WordPress comment id in a second pass, so children may
  arrive before their parents and even in an earlier chunk.
- Rows are keyed on `(project, source, source_id)`: re-sending an export is a
  no-op for rows already present, so retries and chunked uploads are safe.
- `threads_closed` opens those entries' threads closed, matching WordPress
  `comment_status`.
- HTML bodies become plain text (paragraphs → newlines, tags stripped).

## Data model

`comments` (one row per comment; `parent_id` chains replies, `root_id` + `depth`
are materialised by a BEFORE INSERT trigger so a page of threads is one range
scan; unique `(project_id, source, source_id)` for imports) and
`comment_threads` (per-entry `closed_at`; absent row = open). Both carry
`workspace_id` for RLS parity with `form_submissions`: members read, owner/admin
write. Deleting a comment cascades to its replies and is audit-logged like a
form submission. Migration: `supabase/migrations/020_comments.sql` (shared
lineage, both provider pairs).

## Plan features

| key | type | community | starter | pro | enterprise | ee |
|---|---|---|---|---|---|---|
| `comments.enabled` | feature | ✓ | ✓ | ✓ | ✓ | |
| `comments.models` | limit | ∞ | 1 | 15 | ∞ | |
| `comments.per_month` | limit (hard cap, no overage) | ∞ | 500 | 10 000 | ∞ | |
| `comments.captcha` | feature | ✓ | ✓ | ✓ | ✓ | |
| `comments.auto_approve` | feature | ✓ | ✓ | ✓ | ✓ | |
| `comments.import` | feature | ✓ | ✓ | ✓ | ✓ | |
| `comments.webhook_notification` | feature | — | ✓ | ✓ | ✓ | requires ee |
| `comments.spam_filter` | feature (roadmap) | — | — | ✓ | ✓ | requires ee |

## Environment

```
NUXT_TURNSTILE_SECRET_KEY=        # server-side verification (forms + comments)
NUXT_PUBLIC_TURNSTILE_SITE_KEY=   # widget key handed to embeds via the read endpoint
```

Without the secret, a model that asks for captcha rejects every submission —
this also applies to forms, which read the same key.

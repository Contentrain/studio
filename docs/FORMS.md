# Forms

Studio-managed form handling for any site: a model in the repository declares
which of its fields a public form exposes, the site renders the form and posts
to Studio, submissions land in the Studio database for moderation, and an
approved submission becomes a content entry. This is the contract an external
form component (the Astro component of a migrated WordPress site, a plain
`<form>`, a serverless function) builds against.

```
visitor ──► public API (/api/forms/v1) ──► form_submissions ──► moderation (Studio UI / agent / API) ──► content entry (Git)
                                                 └──► owner/admin email · outbound webhook (ee)
```

## Enabling a form on a model

`PATCH /api/workspaces/{workspaceId}/projects/{projectId}/models/{modelId}` with a
`form` block (workspace owner/admin; plan feature `forms.enabled`, `forms.models`
cap). Collection models only. The same block is editable from the model's
**Form** tab in Studio.

| key | default | meaning |
|---|---|---|
| `enabled` | `false` | Accept submissions for this model |
| `public` | `false` | Serve the form config and accept submissions without a session |
| `exposedFields` | `[]` | Field ids the public form shows and accepts (everything else is dropped) |
| `requiredOverrides` | — | `{ fieldId: boolean }` to make a field required/optional on the public form only |
| `honeypot` | `false` | Hidden `_hp` field; a filled honeypot is silently accepted and dropped |
| `captcha` | `null` | `'turnstile'` to require a Cloudflare Turnstile token (needs `forms.captcha` + `NUXT_TURNSTILE_SECRET_KEY`) |
| `limits.rateLimitPerIp` | `10` | Submissions per IP per minute |
| `limits.maxPerMonth` | — | Cap for this form in a calendar month, below the workspace plan limit |
| `autoApprove` | `false` | Create the content entry immediately on submit (needs `forms.auto_approve`) |
| `notifications` | `true` | Email the workspace owner + admins on every submission (needs `forms.notifications`) |
| `successMessage` | — | Returned to the visitor after a successful submit |

## Public API (no auth, CORS `*`)

Both routes are exempt from the session middleware; the `00.public-cors`
middleware answers the `OPTIONS` preflight. Rate limits are per IP.

### Read the form config

```
GET /api/forms/v1/{projectId}/{modelId}/config
```

```jsonc
{
  "modelId": "contact",
  "locale": "en",                       // the project's default locale — what the submission is validated against
  "fields": { "name": { "type": "string", "required": true, … }, "email": { … } },   // exposed fields only
  "captcha": "turnstile" | null,
  "captchaSiteKey": "0x4AAA…" | null,   // NUXT_PUBLIC_TURNSTILE_SITE_KEY, for the widget
  "successMessage": "Thank you!",
  "honeypotField": "_hp" | null
}
```

Render one input per field from `fields` (the shape is the model's `FieldDef`:
`type`, `label`, `required`, `options`, …). If `captcha` is set, mount the
Turnstile widget with `captchaSiteKey` and send its token as `captchaToken`.
If `honeypotField` is set, add a visually hidden input with that name and leave
it empty.

### Submit

```
POST /api/forms/v1/{projectId}/{modelId}/submit
Content-Type: application/json

{ "data": { "name": "Ada", "email": "ada@example.com", "message": "…" }, "captchaToken": "…", "_hp": "" }
```

| response | meaning |
|---|---|
| `200 { success: true, message }` | Stored (or auto-approved). `message` is the model's `successMessage` |
| `200 { success: false, errors: [{ field, message }] }` | Validation against the exposed fields, or `captcha` |
| `403` | Plan lacks `forms.enabled`, or the model is beyond the `forms.models` cap |
| `404` | Unknown project/model, or the form is disabled / not public |
| `429` | Per-IP rate limit, the form's `limits.maxPerMonth`, or the workspace's monthly `forms.submissions_per_month` quota |

Every string value is sanitized (tags, entity-hidden tags and inline script
vectors stripped) before validation; only exposed fields are kept. The
workspace quota check and the insert run atomically inside one database
function (`create_form_submission_if_allowed`).

## After a submission

- **Notification** — with `forms.notifications` and the model's
  `notifications` flag, the workspace owner and every accepted admin receive
  the `form-submitted` email (template in the content layer) with a short
  field summary and a link to the project. Best-effort; a mail failure never
  fails the submit.
- **Webhook** — with `forms.webhook_notification` (ee) a `form.submitted` event
  goes to the project's outbound webhooks.
- **Moderation** — Studio: the model's **Submissions** tab (filters, detail
  modal with approve / reject / delete). Agent tools: `list_submissions`,
  `approve_submission`, `reject_submission`. API (session auth):

| route | role | body |
|---|---|---|
| `GET /api/workspaces/{ws}/projects/{p}/forms/{model}/submissions?status&page&limit&sort` | member+ (members need a project assignment) | — |
| `PATCH …/submissions/{id}` | owner/admin | `{ status: 'approved' \| 'rejected' \| 'spam' }` |
| `DELETE …/submissions/{id}` | owner/admin | — audit-logged |
| `POST …/submissions/bulk` | owner/admin | `{ action: 'approve' \| 'reject' \| 'spam' \| 'delete', submissionIds: [≤50] }` |

- **Approve** creates a draft entry in the model from the submission data,
  written to the locale the submission was validated against (stored on the
  row as `locale`, the project default at submit time), then merges the
  `cr/*` branch on auto-merge projects. `autoApprove` does the same on submit.

## Newsletter sign-ups

There is no separate newsletter product in Studio yet (roadmap, post-M4). A
WordPress newsletter widget (MailPoet, Mailchimp for WP, ConvertKit…) is a
sign-up form, and that maps onto this feature today:

1. Create a `subscribers` collection with `email` (required, `email` type) and
   whatever else the widget collected (`name`, `consent`), enable the form
   with those fields exposed, `autoApprove: true`.
2. Point the migrated site's sign-up form at the submit endpoint above.
3. Bridge to the mailing provider with `forms.webhook_notification` (ee): the
   `form.submitted` webhook carries the submission id; the receiver adds the
   address to Mailchimp / Brevo / ConvertKit. Without ee, the subscribers
   collection itself is the list and can be exported from the repository.

Double opt-in, unsubscribe links and provider sync are part of the
newsletter capability, not of forms.

## Environment

```
NUXT_RESEND_API_KEY=              # required for submission notification emails
NUXT_TURNSTILE_SECRET_KEY=        # only when a form selects captcha: turnstile
NUXT_PUBLIC_TURNSTILE_SITE_KEY=   # widget key exposed through the config endpoint
```

## Plan features

| key | type | community | starter | pro | enterprise | ee |
|---|---|---|---|---|---|---|
| `forms.enabled` | feature | ✓ | ✓ | ✓ | ✓ | |
| `forms.models` | limit | ∞ | 1 | 15 | ∞ | |
| `forms.submissions_per_month` | limit (overage $0.01) | ∞ | 100 | 3 000 | ∞ | |
| `forms.captcha` | feature | ✓ | ✓ | ✓ | ✓ | |
| `forms.auto_approve` | feature | ✓ | ✓ | ✓ | ✓ | |
| `forms.notifications` | feature | ✓ | ✓ | ✓ | ✓ | |
| `forms.webhook_notification` | feature | — | ✓ | ✓ | ✓ | requires ee |
| `forms.file_upload` | feature (roadmap) | — | ✓ | ✓ | ✓ | requires ee |
| `forms.spam_filter` | feature (roadmap) | — | — | ✓ | ✓ | requires ee |

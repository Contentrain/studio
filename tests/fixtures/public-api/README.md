# Public API wire fixtures

The request/response contract of Studio's two visitor-facing surfaces, as
JSON files a client can be built and tested against:

| surface | route | fixtures |
|---|---|---|
| Forms | `GET /api/forms/v1/{projectId}/{modelId}/config` | `forms.config.response.json` |
| Forms | `POST /api/forms/v1/{projectId}/{modelId}/submit` | `forms.submit.request.json` → `forms.submit.success.response.json`; `forms.submit.invalid.request.json` → `forms.submit.validation-error.response.json`; `forms.submit.captcha-error.response.json`; `forms.submit.legacy-flat.request.json` → **400** |
| Comments | `GET /api/comments/v1/{projectId}/{modelId}/{entryId}?locale&page&limit&sort` | `comments.read.response.json` |
| Comments | `POST /api/comments/v1/{projectId}/{modelId}/{entryId}?locale` | `comments.submit.request.json` → `comments.submit.pending.response.json` / `comments.submit.approved.response.json`; `comments.submit.invalid.request.json` → `comments.submit.validation-error.response.json`; `comments.submit.honeypot.response.json` |
| CORS | `OPTIONS` on either prefix | `cors.preflight.response.json` |
| Errors | every non-200 | `errors.json` |

`tests/integration/public-api-fixtures.integration.test.ts` runs the real
route handlers (real CORS middleware, real dictionary messages, real content
validator; database and Git mocked) and asserts each response equals its
fixture byte-for-byte after JSON parsing. A route change that alters the
wire shape fails that test, so these files are the contract — update the
fixture and the docs (`docs/FORMS.md`, `docs/COMMENTS.md`) in the same PR.

## Rules a client must follow

- **Body envelope.** Forms: `{ data, captchaToken?, _hp? }` — field values go
  under `data`, never at the top level. Comments: `{ author: { name, email?,
  url? }, body, parentId?, captchaToken?, _hp? }`. A flat form body is a
  `400`; `cf-turnstile-response` is not read anywhere.
- **No credentials.** Both surfaces are unauthenticated. The preflight only
  allows `Content-Type`, so a browser request carrying `Authorization` fails
  CORS before it reaches Studio. Never ship a Studio key into a page.
- **CAPTCHA.** When `captcha` is `"turnstile"`, mount the widget with
  `captchaSiteKey` and send its token as `captchaToken`. A missing or
  rejected token is a `200 { success: false, errors: [{ field: "captcha" }] }`,
  not a 4xx.
- **Honeypot.** When `honeypotField` is set, render a hidden input with that
  name and send it empty. A filled one is silently "accepted" (`200`) and
  dropped.
- **Errors.** `success: false` + `errors[]` is a `200` (validation, captcha,
  bad parent). Plan, disabled, unknown, closed and quota conditions are
  `403` / `404` / `429` with `{ statusCode, message }` — see `errors.json`.
- **Privacy.** The read endpoint never returns an email, IP address, user
  agent or referrer; `body` is plain text and must be rendered escaped.
- **Locale.** Forms: validated against `locale` from the config response.
  Comments: `?locale=` selects the thread; an invalid value silently falls
  back to the project default, which the response echoes under `entry.locale`.

# Generated-site browser preflight

This read-only gate runs against an **existing Astro dist** on an ephemeral
loopback HTTP port. It does not build or change the project, submit forms,
moderate comments, test deployment, or measure visual fidelity.

```sh
PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/absolute/path/to/chromium \
node scripts/wp-runtime-preflight.mjs \
  /absolute/path/project/dist /absolute/path/contentrain-handoff.json \
  /article/ /newsletter/
```

The browser checks supplied routes at widths 1280 and 390, with light color
scheme and a fresh context per page. Nonlocal requests, non-GET/HEAD requests,
WebSockets and service workers are blocked. This is a diagnostic harness, not
a hardened sandbox for arbitrary customer code. Use controlled test artifacts.

Exit 1 means blockers were found; exit 0 means only `preflight_passed`.
`fullAcceptance` is always false. Missing headings, navigation failures, HTTP
errors, broken completed image loads, empty `cr-component` elements, blocked
requests and page errors are recorded. Offscreen/lazy media is not exhaustively
tested. The handoff's `needs_runtime` capabilities remain pending: finding
markup cannot prove functional runtime integration. Supply both article and
archive routes for full static-route sampling; selected-route success is not
whole-site coverage. Screenshots, pixel scores and mobile touch behavior are
outside this gate.

## Historical artifact baseline, 2026-09-09

Artifact: Migrate blind-v1 `around-the-blue/project/dist`, handoff generated
2026-09-03T17:11:44.328Z. Checked `/it/una-terra-di-contrasti/` and
`/it/newsletter/`, at both widths. **Blocked**, not a new migration KPI.

- All four route/viewport checks returned usable pages with h1 headings.
- External request attempts remained: Cookiebot, a third-party widget, source
  WP animation JSON; the newsletter also requested a source WP video and
  `/wp-json/contact-form-7/v1/contact-forms/1092/feedback/schema`.
- Browser script errors occurred with these dependencies blocked. The gate
  records the symptom; it does not attribute every error to a particular script.
- Handoff still declares forms/comments `needs_runtime`; no live submission
  or moderation acceptance has occurred.
- No external request was intentionally allowed and no form was submitted.

This old artifact predates the current parallel work. Rerun with the new
Migrate output when its session hands over the build; do not treat these
findings as a regression in code that has not yet been integrated.

Next integration gate, after runtime sessions deliver: generated Astro →
submit → Studio persistence → moderation → public read. That requires a
disposable configured Studio project and explicit test identities; this
preflight does not silently create them or substitute mocked APIs.

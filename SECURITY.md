# Security Policy

## Reporting a Vulnerability

If you believe you have found a security vulnerability in Contentrain Studio, report it privately to:

- [security@contentrain.io](mailto:security@contentrain.io)

Do not open public GitHub issues for security reports.

Please include:

- A clear description of the issue and the affected surface
- Reproduction steps or a proof of concept
- Impact and exploitation prerequisites
- Any relevant logs, screenshots, or request samples
- Your suggested fix, if you have one

## Scope

### In Scope

- Contentrain Studio core (`app/`, `server/`, `supabase/`, tests, build/deploy files)
- Enterprise Edition code in [`ee/`](ee/)
- Official Docker images and container configuration
- Auth flows, session handling, and access-control logic
- API routes, middleware, provider boundaries, and background jobs
- Supabase Row-Level Security policies and database migrations
- Webhook verification and webhook delivery signing
- Public-facing delivery surfaces such as forms, media, and CDN routes

### Out of Scope

- Vulnerabilities in third-party dependencies that should be reported upstream first
- Issues in Supabase, GitHub, Stripe, Resend, Anthropic, or other vendor platforms themselves
- Self-hosted deployment mistakes such as leaked credentials, disabled TLS, overly permissive reverse proxies, or public admin endpoints
- Local development-only weaknesses that cannot affect a real deployment
- Social engineering, phishing, or credential stuffing without a product vulnerability

## Response Targets

| Stage | Target |
| --- | --- |
| Acknowledgment | Within 48 hours |
| Initial triage | Within 5 business days |
| Critical / High remediation target | Within 30 days |
| Medium / Low remediation target | Best effort, usually in a scheduled release |

These are targets, not guarantees. Complex fixes may require coordinated releases or vendor involvement.

## Supported Versions

Until a long-term support policy is published, security fixes are prioritized for:

- The latest tagged release
- The current default branch

Older forks and heavily modified self-hosted deployments may need to backport fixes manually.

## Current Security Characteristics

The current codebase includes the following notable security measures:

- AES-256 encrypted `httpOnly` session cookies
- Row-Level Security on Supabase-backed application data
- HMAC-SHA256 signed outbound webhooks
- Provider boundaries for auth, database, storage, git, email, AI, CDN, and billing integrations
- Workspace/project role enforcement and model/tool-level permission checks
- Automated typecheck and test coverage across unit, integration, Nuxt, RLS, and E2E suites

Security posture still depends on correct self-hosted deployment practices, secret management, TLS termination, and infrastructure isolation.

## Disclosure

Please give us reasonable time to investigate and ship a fix before public disclosure. Once a fix is available, we may publish an advisory or release note describing the issue and remediation.

## Contact

- Security reports: [security@contentrain.io](mailto:security@contentrain.io)
- General project discussions: [GitHub Discussions](https://github.com/Contentrain/studio/discussions)

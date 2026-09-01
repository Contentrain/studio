/**
 * Which build is this?
 *
 * The answer an operator needs first — before a bug report, before "is the fix
 * deployed yet" — and the one the product could not give: `/about` described
 * the deployment's profile and edition, `/api/health` said `ok`, and neither
 * named the version. Both values are stamped at build time
 * (`runtimeConfig.public.build` in `nuxt.config.ts`) so they describe the
 * artifact, not whatever `package.json` happens to be on the host.
 */
export interface BuildInfo {
  /** `package.json` version, without a `v` prefix. */
  version: string
  /** Full commit sha the build was made from; empty when the builder did not know. */
  commit: string
}

/** The seven characters a person compares against a git log. */
export function shortCommit(commit: string | null | undefined): string {
  return (commit ?? '').trim().slice(0, 7)
}

/**
 * `v0.3.0 (1a2b3c4)` — the tag plus the commit, because between two tags the
 * tag alone does not say which build off `main` is running. A build that knows
 * neither reads `unknown` rather than an invented value.
 */
export function formatBuildVersion(build: Partial<BuildInfo> | null | undefined): string {
  const version = (build?.version ?? '').trim()
  const sha = shortCommit(build?.commit)
  if (version && sha) return `v${version} (${sha})`
  if (version) return `v${version}`
  if (sha) return sha
  return 'unknown'
}

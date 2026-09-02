/**
 * Liveness, plus which build is answering. Uptime checks can assert on
 * `version`/`commit` after a deploy instead of asking whoever ran it.
 */
export default defineEventHandler(() => {
  const build = (useRuntimeConfig().public as { build?: { version?: string, commit?: string } }).build
  return {
    status: 'ok',
    timestamp: new Date().toISOString(),
    version: build?.version ?? '',
    commit: build?.commit ?? '',
  }
})

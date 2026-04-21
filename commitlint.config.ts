export default {
  extends: ['@commitlint/config-conventional'],
  // Contentrain MCP auto-commits content changes with `[contentrain] ...`
  // messages. They are machine-generated and must not block the conventional
  // gate, so skip lint for any commit whose subject carries that prefix.
  ignores: [
    (commit: string) => /^\[contentrain\]/.test(commit),
  ],
}

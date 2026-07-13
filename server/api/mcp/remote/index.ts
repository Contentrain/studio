/**
 * Bare /api/mcp/remote — the exact URL MCP clients POST/GET/DELETE (the
 * streamable transport uses a single endpoint). Nitro's catch-all sibling
 * ([...slug].ts) only matches subpaths, so the base path re-exports the
 * same handler; getRouterParam('slug') resolves to '' here, which the
 * pipeline maps to the loopback server's root MCP path.
 */
export { default } from './[...slug]'

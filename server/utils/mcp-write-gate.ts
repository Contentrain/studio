/**
 * Call-time role gate for MCP Cloud tool calls.
 *
 * The UI routes and the chat agent check the caller's role on every write; an
 * OAuth grant or an API key only says which tools may be called at all. This
 * gate applies the UI's rule to each `tools/call` before it reaches the
 * loopback server, with the permissions of the person the call acts for
 * (`resolveMcpActorPermissions`):
 *
 * - content_save / content_delete / model_save / model_delete / vocabulary /
 *   media writes need the same Studio tool the UI route would need;
 * - content_status follows status.patch.ts — `published` needs owner/admin,
 *   any other status needs `save_content`;
 * - a model-restricted member reaches only their models;
 * - a tool MCP does not mark read-only and this map does not know needs owner/admin.
 *
 * It fails closed: no permissions, an unreadable message, missing arguments, a
 * missing model or status — each is a refusal, never a pass.
 */
import type { AgentPermissions } from './agent-permissions'
import { canSetEntryStatus } from './agent-permissions'
import { errorMessage } from './content-strings'
import { TOOL_ANNOTATIONS } from '@contentrain/mcp/tools/annotations'

export const CONTENT_STATUS_TOOL = 'contentrain_content_status'

/** One `tools/call` message as the gate reads it. */
export interface ToolCallMessage {
  id: string | number | null
  name: string | null
  arguments: Record<string, unknown> | null
}

/**
 * Every `tools/call` in a JSON-RPC body, with its id and arguments — batch
 * arrays included. `malformed` is set when a tools/call message cannot be read
 * (no string name, arguments that are not an object): the gate refuses those.
 */
export function readToolCallMessages(rawBody: string | undefined): { calls: ToolCallMessage[], malformed: boolean } {
  if (!rawBody) return { calls: [], malformed: false }
  let parsed: unknown
  try {
    parsed = JSON.parse(rawBody)
  }
  catch {
    // The loopback cannot run what it cannot parse either.
    return { calls: [], malformed: false }
  }
  const messages = Array.isArray(parsed) ? parsed : [parsed]
  const calls: ToolCallMessage[] = []
  let malformed = false
  for (const message of messages) {
    if (!message || typeof message !== 'object') continue
    const { id, method, params } = message as { id?: unknown, method?: unknown, params?: unknown }
    if (method !== 'tools/call') continue
    const p = params && typeof params === 'object' ? params as { name?: unknown, arguments?: unknown } : {}
    const name = typeof p.name === 'string' ? p.name : null
    const args = p.arguments === undefined
      ? {}
      : p.arguments && typeof p.arguments === 'object' && !Array.isArray(p.arguments) ? p.arguments as Record<string, unknown> : null
    if (!name || !args) malformed = true
    calls.push({ id: typeof id === 'string' || typeof id === 'number' ? id : null, name, arguments: args })
  }
  return { calls, malformed }
}

/** MCP write tool → the Studio tool whose role it needs, and where its model id is. */
const WRITE_TOOL_RULES: Record<string, { tool: string, modelArg?: 'model' | 'id' }> = {
  contentrain_content_save: { tool: 'save_content', modelArg: 'model' },
  contentrain_content_delete: { tool: 'delete_content', modelArg: 'model' },
  contentrain_model_save: { tool: 'save_model', modelArg: 'id' },
  contentrain_model_delete: { tool: 'delete_model', modelArg: 'model' },
  contentrain_vocabulary_save: { tool: 'vocabulary' },
  contentrain_vocabulary_delete: { tool: 'vocabulary' },
  contentrain_media_ingest: { tool: 'upload_media' },
  contentrain_media_update: { tool: 'update_media' },
  contentrain_media_delete: { tool: 'delete_media' },
}

function modelDenial(permissions: AgentPermissions, modelId: string): string | null {
  if (permissions.specificModels && !permissions.allowedModels.includes(modelId))
    return errorMessage('content.model_no_access', { model: modelId })
  return null
}

/**
 * Why this call may not run for these permissions, or null when it may.
 * Reads (read-only tools, and validate without `fix`) need only a membership.
 */
export function toolCallDenial(call: ToolCallMessage, permissions: AgentPermissions | null): string | null {
  const denied = errorMessage('content.insufficient_permissions')
  if (!permissions || !call.name || !call.arguments) return denied
  const args = call.arguments

  if (call.name === CONTENT_STATUS_TOOL) {
    const status = args.status
    const model = args.model
    if (typeof status !== 'string' || !status) return errorMessage('validation.status_invalid')
    if (typeof model !== 'string' || !model) return denied
    const denial = canSetEntryStatus(permissions, status, model)
    return denial ? errorMessage(denial.key, denial.params) : null
  }

  // validate is a write only when it is asked to fix.
  if (call.name === 'contentrain_validate')
    return args.fix === true && !permissions.availableTools.includes('save_content') ? denied : null

  const rule = WRITE_TOOL_RULES[call.name]
  if (rule) {
    if (!permissions.availableTools.includes(rule.tool)) return denied
    if (!rule.modelArg) return null
    const model = args[rule.modelArg]
    if (typeof model !== 'string' || !model) return denied
    return modelDenial(permissions, model)
  }

  // Reads are the tools MCP marks read-only. Anything else this gate has no
  // rule for — a write, or a name MCP does not list — is owner/admin only.
  if (TOOL_ANNOTATIONS[call.name]?.readOnlyHint === true) return null
  return permissions.workspaceRole === 'owner' || permissions.workspaceRole === 'admin' ? null : denied
}

/**
 * The JSON-RPC answer for refused calls: one `isError` tool result per call,
 * shaped as the loopback would answer a tool that failed. In a batch where any
 * call is refused, none runs — each one is answered.
 */
export function refusedToolCallsResponse(calls: ToolCallMessage[], denials: Array<string | null>, batch: boolean): unknown {
  const refusedOne = denials.find(Boolean) ?? errorMessage('content.insufficient_permissions')
  const responses = calls.map((call, i) => ({
    jsonrpc: '2.0',
    id: call.id,
    result: {
      isError: true,
      content: [{ type: 'text', text: denials[i] ?? refusedOne }],
    },
  }))
  return batch ? responses : responses[0]
}

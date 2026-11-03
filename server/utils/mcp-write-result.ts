/**
 * Reading and annotating the loopback's answer to a write `tools/call`.
 *
 * The write path buffers the loopback response (see `runMcpCloudProxy`), so
 * Studio can read which branch each write produced — from the tool result's
 * `git.branch`, never from a branch listing — and then tell the agent what
 * happened to it: landed on the content branch, or held for review and why.
 * The answer may be a JSON body or a streamable-HTTP SSE frame; both are read
 * and rewritten in the framing they came in. Anything that does not parse is
 * passed through untouched.
 */
import type { McpCloudMergeOutcome } from './mcp-cloud-automerge'

interface RpcMessage {
  id?: unknown
  result?: { isError?: boolean, content?: Array<{ type?: string, text?: unknown }> }
}

/** One write result: the JSON-RPC id it answers, its branch and commit. */
export interface WriteResultRef {
  id: string | number
  branch: string
  commitSha?: string
}

type Frame
  = | { kind: 'json', batch: boolean, messages: RpcMessage[] }
    | { kind: 'sse', lines: string[], dataLines: Array<{ index: number, message: RpcMessage }> }

function parseFrame(body: string, contentType: string | null): Frame | null {
  try {
    if (contentType?.includes('text/event-stream')) {
      const lines = body.split('\n')
      const dataLines: Array<{ index: number, message: RpcMessage }> = []
      lines.forEach((line, index) => {
        if (!line.startsWith('data:')) return
        const parsed = JSON.parse(line.slice(5).trim()) as RpcMessage
        dataLines.push({ index, message: parsed })
      })
      return { kind: 'sse', lines, dataLines }
    }
    const parsed = JSON.parse(body) as RpcMessage | RpcMessage[]
    return Array.isArray(parsed) ? { kind: 'json', batch: true, messages: parsed } : { kind: 'json', batch: false, messages: [parsed] }
  }
  catch {
    return null
  }
}

function messagesOf(frame: Frame): RpcMessage[] {
  return frame.kind === 'json' ? frame.messages : frame.dataLines.map(d => d.message)
}

function toolResultJson(message: RpcMessage): Record<string, unknown> | null {
  if (!message?.result || message.result.isError) return null
  const text = message.result.content?.find(c => c?.type === 'text')?.text
  if (typeof text !== 'string') return null
  try {
    const parsed = JSON.parse(text) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null
  }
  catch {
    return null
  }
}

/** The branch each successful write result names, keyed by the request id it answers. */
export function readWriteResults(body: string, contentType: string | null): WriteResultRef[] {
  const frame = parseFrame(body, contentType)
  if (!frame) return []
  const refs: WriteResultRef[] = []
  for (const message of messagesOf(frame)) {
    if (typeof message?.id !== 'string' && typeof message?.id !== 'number') continue
    const git = toolResultJson(message)?.git as { branch?: unknown, commit?: unknown } | undefined
    if (typeof git?.branch !== 'string' || !git.branch) continue
    refs.push({ id: message.id, branch: git.branch, ...(typeof git.commit === 'string' ? { commitSha: git.commit } : {}) })
  }
  return refs
}

/** What the agent is told about its branch. A pending outcome changes nothing. */
function annotate(result: Record<string, unknown>, outcome: McpCloudMergeOutcome): Record<string, unknown> {
  const git = (result.git ?? {}) as Record<string, unknown>
  if (outcome.status === 'merged')
    return { ...result, git: { ...git, action: 'merged' }, merge: { status: 'merged', note: 'Studio merged this branch into the content branch.' } }
  if (outcome.status === 'held') {
    return {
      ...result,
      merge: {
        status: 'held_for_review',
        note: 'The project\'s approval policy holds this change for review; it stays on its branch until someone approves it in Studio.',
        ...(outcome.approval ? { approval: outcome.approval } : {}),
      },
    }
  }
  return result
}

/**
 * Rewrite the response with each write's outcome. Returns the body unchanged
 * when nothing applies or anything fails to parse.
 */
export function annotateWriteResults(body: string, contentType: string | null, outcomes: Map<string, McpCloudMergeOutcome>): string {
  if (outcomes.size === 0) return body
  const frame = parseFrame(body, contentType)
  if (!frame) return body

  const rewrite = (message: RpcMessage): RpcMessage => {
    const result = toolResultJson(message)
    const branch = (result?.git as { branch?: unknown } | undefined)?.branch
    const outcome = typeof branch === 'string' ? outcomes.get(branch) : undefined
    if (!result || !outcome || outcome.status === 'pending') return message
    const content = (message.result?.content ?? []).map(c => c?.type === 'text' && typeof c.text === 'string'
      ? { ...c, text: JSON.stringify(annotate(result, outcome)) }
      : c)
    return { ...message, result: { ...message.result, content } }
  }

  if (frame.kind === 'json') {
    const messages = frame.messages.map(rewrite)
    return JSON.stringify(frame.batch ? messages : messages[0])
  }
  const lines = [...frame.lines]
  for (const { index, message } of frame.dataLines)
    lines[index] = `data: ${JSON.stringify(rewrite(message))}`
  return lines.join('\n')
}

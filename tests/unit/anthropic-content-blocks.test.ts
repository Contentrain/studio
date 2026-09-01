import { describe, expect, it } from 'vitest'
import { canonicalizeJson, toAnthropicMessages } from '../../server/providers/anthropic-ai'

describe('toAnthropicMessages — attachment content blocks', () => {
  it('passes a plain string through unchanged', () => {
    const out = toAnthropicMessages([{ role: 'user', content: 'hello' }])
    expect(out).toEqual([{ role: 'user', content: 'hello' }])
  })

  it('maps a base64 image block to Anthropic shape (mediaType → media_type)', () => {
    const out = toAnthropicMessages([{
      role: 'user',
      content: [{ type: 'image', source: { type: 'base64', mediaType: 'image/webp', data: 'AAAA' } }],
    }])
    expect((out[0]!.content as unknown[])[0]).toEqual({
      type: 'image',
      source: { type: 'base64', media_type: 'image/webp', data: 'AAAA' },
    })
  })

  it('maps a URL image block to a url source', () => {
    const out = toAnthropicMessages([{
      role: 'user',
      content: [{ type: 'image', source: { type: 'url', url: 'https://cdn.example/media/x.png' } }],
    }])
    expect((out[0]!.content as unknown[])[0]).toEqual({
      type: 'image',
      source: { type: 'url', url: 'https://cdn.example/media/x.png' },
    })
  })

  it('maps a PDF document block to a base64 document source', () => {
    const out = toAnthropicMessages([{
      role: 'user',
      content: [{ type: 'document', source: { type: 'base64', mediaType: 'application/pdf', data: 'JVBE' } }],
    }])
    expect((out[0]!.content as unknown[])[0]).toEqual({
      type: 'document',
      source: { type: 'base64', media_type: 'application/pdf', data: 'JVBE' },
    })
  })

  it('preserves attachment-before-text ordering', () => {
    const out = toAnthropicMessages([{
      role: 'user',
      content: [
        { type: 'document', source: { type: 'base64', mediaType: 'application/pdf', data: 'JVBE' } },
        { type: 'text', text: 'summarize' },
      ],
    }])
    const blocks = out[0]!.content as Array<{ type: string }>
    expect(blocks[0]!.type).toBe('document')
    expect(blocks[1]!.type).toBe('text')
  })

  it('maps isError onto the wire is_error flag, omitting it otherwise', () => {
    const out = toAnthropicMessages([{
      role: 'user',
      content: [
        { type: 'tool_result', toolUseId: 't1', content: '{"error":"boom"}', isError: true },
        { type: 'tool_result', toolUseId: 't2', content: '{"ok":true}' },
      ],
    }])
    const blocks = out[0]!.content as Array<Record<string, unknown>>
    expect(blocks[0]).toEqual({ type: 'tool_result', tool_use_id: 't1', content: '{"error":"boom"}', is_error: true })
    expect(blocks[1]).toEqual({ type: 'tool_result', tool_use_id: 't2', content: '{"ok":true}' })
  })
})

describe('toAnthropicMessages — prompt cache markers and replay determinism', () => {
  it('maps a cacheControl marker on a message block to cache_control with its TTL', () => {
    const out = toAnthropicMessages([{
      role: 'assistant',
      content: [
        { type: 'text', text: 'earlier' },
        { type: 'text', text: 'tail', cacheControl: { type: 'ephemeral', ttl: '1h' } },
      ],
    }])
    const blocks = out[0]!.content as Array<Record<string, unknown>>
    expect(blocks[0]).toEqual({ type: 'text', text: 'earlier' })
    expect(blocks[1]).toEqual({ type: 'text', text: 'tail', cache_control: { type: 'ephemeral', ttl: '1h' } })
  })

  it('accepts the marker on tool_use and tool_result blocks too', () => {
    const out = toAnthropicMessages([
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'get_content', input: {}, cacheControl: { type: 'ephemeral' } }] },
      { role: 'user', content: [{ type: 'tool_result', toolUseId: 't1', content: '{}', cacheControl: { type: 'ephemeral' } }] },
    ])
    expect((out[0]!.content as Array<Record<string, unknown>>)[0]).toMatchObject({ cache_control: { type: 'ephemeral' } })
    expect((out[1]!.content as Array<Record<string, unknown>>)[0]).toMatchObject({ cache_control: { type: 'ephemeral' } })
  })

  it('never emits cache_control (not even null) on unmarked blocks', () => {
    const out = toAnthropicMessages([{ role: 'user', content: [{ type: 'text', text: 'plain' }] }])
    expect((out[0]!.content as Array<Record<string, unknown>>)[0]).not.toHaveProperty('cache_control')
  })

  it('sorts tool_use input keys recursively so a jsonb replay serializes like the live turn', () => {
    const live = { title: 'T', body: 'B', meta: { z: 1, a: [{ y: 2, x: 1 }] } }
    const replayed = { meta: { a: [{ x: 1, y: 2 }], z: 1 }, body: 'B', title: 'T' }
    const [a] = toAnthropicMessages([{ role: 'assistant', content: [{ type: 'tool_use', id: 't', name: 'save_content', input: live }] }])
    const [b] = toAnthropicMessages([{ role: 'assistant', content: [{ type: 'tool_use', id: 't', name: 'save_content', input: replayed }] }])
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
    expect(JSON.stringify((a!.content as Array<{ input: unknown }>)[0]!.input))
      .toBe('{"body":"B","meta":{"a":[{"x":1,"y":2}],"z":1},"title":"T"}')
  })

  it('canonicalizeJson leaves arrays ordered and primitives untouched', () => {
    expect(canonicalizeJson([3, 1, 2])).toEqual([3, 1, 2])
    expect(canonicalizeJson('s')).toBe('s')
    expect(canonicalizeJson(null)).toBeNull()
  })
})

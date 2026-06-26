import { describe, expect, it } from 'vitest'
import { toAnthropicMessages } from '../../server/providers/anthropic-ai'

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
})

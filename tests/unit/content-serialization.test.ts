import { describe, expect, it, vi } from 'vitest'
import {
  generateEntryId,
  parseMarkdownFrontmatter,
  serializeCanonical,
  serializeMarkdownFrontmatter,
} from '../../server/utils/content-serialization'

describe('content serialization', () => {
  it('serializes canonical JSON with sorted keys and omitted defaults', () => {
    const result = serializeCanonical(
      {
        zeta: 1,
        alpha: 'keep',
        hidden: null,
        count: 0,
        nested: {
          b: true,
          a: 'sorted',
        },
      },
      {
        count: { type: 'number', default: 0 },
      },
    )

    expect(result).toBe(
      [
        '{',
        '  "alpha": "keep",',
        '  "nested": {',
        '    "a": "sorted",',
        '    "b": true',
        '  },',
        '  "zeta": 1',
        '}',
        '',
      ].join('\n'),
    )
  })

  it('generates stable 12 character lowercase hex ids', () => {
    vi.spyOn(crypto, 'getRandomValues').mockImplementation((bytes) => {
      const target = bytes as Uint8Array
      target.set([0xab, 0xcd, 0xef, 0x12, 0x34, 0x56])
      return bytes
    })

    expect(generateEntryId()).toBe('abcdef123456')
  })

  it('parses markdown frontmatter with arrays and primitive values', () => {
    const parsed = parseMarkdownFrontmatter(`---
title: Hello
published: true
priority: 3
tags:
  - news
  - launch
---
Body copy`)

    expect(parsed.frontmatter).toEqual({
      title: 'Hello',
      published: true,
      priority: 3,
      tags: ['news', 'launch'],
    })
    expect(parsed.body).toBe('Body copy')
  })

  it('serializes frontmatter back to markdown in key order', () => {
    const markdown = serializeMarkdownFrontmatter(
      {
        tags: ['news', 'launch'],
        title: 'Hello',
        published: true,
      },
      'Body copy',
    )

    expect(markdown).toBe(`---
published: true
tags:
  - news
  - launch
title: Hello
---

Body copy`)
  })
})

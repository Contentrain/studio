import { describe, expect, it } from 'vitest'
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
    const id = generateEntryId()
    expect(id).toHaveLength(12)
    expect(id).toMatch(/^[0-9a-f]{12}$/)

    // Each call produces a different ID
    const id2 = generateEntryId()
    expect(id2).not.toBe(id)
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

  it('serializes frontmatter back to markdown with all fields', () => {
    const markdown = serializeMarkdownFrontmatter(
      {
        tags: ['news', 'launch'],
        title: 'Hello',
        published: true,
      },
      'Body copy',
    )

    // Verify delimiters and content structure
    expect(markdown).toContain('---')
    expect(markdown).toContain('title: Hello')
    expect(markdown).toContain('tags:')
    expect(markdown).toContain('  - news')
    expect(markdown).toContain('  - launch')
    expect(markdown).toContain('published:')
    expect(markdown).toContain('Body copy')
  })
})

import { describe, expect, it } from 'vitest'
import { slugify } from '../../server/utils/slug'

describe('slugify', () => {
  it('creates lowercase strict slugs', () => {
    expect(slugify('My Workspace Name')).toBe('my-workspace-name')
  })

  it('strips unsupported characters and trims whitespace', () => {
    expect(slugify('  Docs / Blog + API  ')).toBe('docs-blog-api')
  })
})

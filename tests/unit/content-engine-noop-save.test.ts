import type { RepoReader } from '@contentrain/types'
import { describe, expect, it } from 'vitest'
import { planMatchesCurrent } from '../../server/utils/content-engine/helpers'

function readerOf(files: Record<string, string>): RepoReader {
  return {
    readFile: async (path) => {
      if (path in files) return files[path]!
      throw new Error(`404: ${path}`)
    },
    listDirectory: async () => [],
    fileExists: async path => path in files,
  }
}

describe('planMatchesCurrent — no-op save detection', () => {
  const content = '{\n  "hero": "Hello"\n}\n'
  const meta = '{\n  "hero": { "status": "published" }\n}\n'

  it('detects a byte-identical plan as a no-op', async () => {
    const reader = readerOf({ 'content/a/en.json': content, 'content/a/en.meta.json': meta })
    const matches = await planMatchesCurrent(reader, [
      { path: 'content/a/en.json', content },
      { path: 'content/a/en.meta.json', content: meta },
    ])
    expect(matches).toBe(true)
  })

  it('any differing file makes it a real save', async () => {
    const reader = readerOf({ 'content/a/en.json': content, 'content/a/en.meta.json': meta })
    const matches = await planMatchesCurrent(reader, [
      { path: 'content/a/en.json', content: content.replace('Hello', 'Merhaba') },
      { path: 'content/a/en.meta.json', content: meta },
    ])
    expect(matches).toBe(false)
  })

  it('a brand-new file is never a no-op', async () => {
    const reader = readerOf({})
    expect(await planMatchesCurrent(reader, [{ path: 'content/a/en.json', content }])).toBe(false)
  })

  it('deletions and empty plans are never no-ops', async () => {
    const reader = readerOf({ 'content/a/en.json': content })
    expect(await planMatchesCurrent(reader, [{ path: 'content/a/en.json', content: null }])).toBe(false)
    expect(await planMatchesCurrent(reader, [])).toBe(false)
  })
})

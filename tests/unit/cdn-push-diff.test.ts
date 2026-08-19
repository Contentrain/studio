import { describe, expect, it, vi } from 'vitest'
import { resolvePushDiff } from '../../server/utils/cdn-push-diff'

/**
 * Regression coverage for issue #133: webhook-triggered CDN builds must
 * derive changed paths from the Compare API, never from push-payload
 * commit file lists — and every ambiguity must degrade to a FULL rebuild
 * (over-building is safe, stale delivery is not).
 */
describe('resolvePushDiff', () => {
  const paths = (files: string[]) => files.map(path => ({ path }))

  it('returns precise changed paths when the compare succeeds', async () => {
    const getDiff = vi.fn().mockResolvedValue(paths([
      '.contentrain/content/blog/posts/en.json',
      '.contentrain/meta/posts/en.json',
    ]))

    const decision = await resolvePushDiff({ before: 'a'.repeat(40), after: 'b'.repeat(40), getDiff })

    expect(decision).toEqual({
      action: 'build',
      changedPaths: ['.contentrain/content/blog/posts/en.json', '.contentrain/meta/posts/en.json'],
    })
    expect(getDiff).toHaveBeenCalledWith('b'.repeat(40), 'a'.repeat(40))
  })

  it('full-rebuilds on ref creation (zero-SHA before)', async () => {
    const getDiff = vi.fn()
    const decision = await resolvePushDiff({ before: '0'.repeat(40), after: 'b'.repeat(40), getDiff })

    expect(decision).toEqual({ action: 'build', fullRebuild: true })
    expect(getDiff).not.toHaveBeenCalled()
  })

  it('full-rebuilds when the payload carries no before SHA', async () => {
    const decision = await resolvePushDiff({ after: 'b'.repeat(40), getDiff: vi.fn() })

    expect(decision).toEqual({ action: 'build', fullRebuild: true })
  })

  it('skips entirely on ref deletion (zero-SHA after)', async () => {
    const getDiff = vi.fn()
    const decision = await resolvePushDiff({ before: 'a'.repeat(40), after: '0'.repeat(40), getDiff })

    expect(decision).toEqual({ action: 'skip' })
    expect(getDiff).not.toHaveBeenCalled()
  })

  it('skips when the ref moved but the tree is identical (no-op force push)', async () => {
    const decision = await resolvePushDiff({
      before: 'a'.repeat(40),
      after: 'b'.repeat(40),
      getDiff: vi.fn().mockResolvedValue([]),
    })

    expect(decision).toEqual({ action: 'skip' })
  })

  it('full-rebuilds when the compare hits the 300-file truncation cap', async () => {
    const decision = await resolvePushDiff({
      before: 'a'.repeat(40),
      after: 'b'.repeat(40),
      getDiff: vi.fn().mockResolvedValue(paths(Array.from({ length: 300 }, (_, i) => `f${i}.json`))),
    })

    expect(decision).toEqual({ action: 'build', fullRebuild: true })
  })

  it('full-rebuilds when the compare call fails', async () => {
    const decision = await resolvePushDiff({
      before: 'a'.repeat(40),
      after: 'b'.repeat(40),
      getDiff: vi.fn().mockRejectedValue(new Error('compare exploded')),
    })

    expect(decision).toEqual({ action: 'build', fullRebuild: true })
  })
})

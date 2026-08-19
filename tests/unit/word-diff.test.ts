import { describe, expect, it } from 'vitest'
import { wordDiff } from '../../app/utils/word-diff'

/** Reassemble a side, to prove nothing was dropped or duplicated. */
const join = (parts: Array<{ value: string }>) => parts.map(p => p.value).join('')

describe('wordDiff', () => {
  it('marks only the words that moved', () => {
    const result = wordDiff('The quick brown fox', 'The quick red fox')

    expect(result.after.filter(p => p.kind === 'added').map(p => p.value.trim())).toEqual(['red'])
    expect(result.before.filter(p => p.kind === 'removed').map(p => p.value.trim())).toEqual(['brown'])
  })

  it('reassembles both sides exactly', () => {
    const before = 'One two three four five'
    const after = 'One two THREE four five six'
    const result = wordDiff(before, after)

    expect(join(result.before)).toBe(before)
    expect(join(result.after)).toBe(after)
  })

  it('finds a change buried deep in a long body', () => {
    // The case the old 120-character clip reported as "unchanged".
    const filler = Array.from({ length: 300 }, (_, i) => `word${i}`).join(' ')
    const result = wordDiff(`${filler} before ${filler}`, `${filler} after ${filler}`)

    expect(result.coarse).toBe(false)
    expect(result.after.filter(p => p.kind === 'added').map(p => p.value.trim())).toEqual(['after'])
  })

  it('reports one whole block when the texts share almost nothing', () => {
    const a = Array.from({ length: 500 }, (_, i) => `alpha${i}`).join(' ')
    const b = Array.from({ length: 500 }, (_, i) => `beta${i}`).join(' ')
    const result = wordDiff(a, b)

    expect(result.coarse).toBe(true)
    expect(join(result.before)).toBe(a)
    expect(join(result.after)).toBe(b)
  })

  it('treats identical text as identical', () => {
    const result = wordDiff('same text', 'same text')

    expect(result.before.every(p => p.kind === 'same')).toBe(true)
    expect(result.after.every(p => p.kind === 'same')).toBe(true)
  })

  it('handles an empty side', () => {
    const added = wordDiff('', 'brand new')
    expect(join(added.after)).toBe('brand new')
    expect(added.after.some(p => p.kind === 'added')).toBe(true)

    const cleared = wordDiff('was here', '')
    expect(join(cleared.before)).toBe('was here')
    expect(cleared.before.some(p => p.kind === 'removed')).toBe(true)
  })

  it('preserves newlines so a markdown body stays readable', () => {
    const before = '# Title\n\nFirst para.\n\nSecond para.'
    const after = '# Title\n\nFirst para.\n\nSecond paragraph.'
    const result = wordDiff(before, after)

    expect(join(result.after)).toBe(after)
    expect(result.after.filter(p => p.kind === 'added').map(p => p.value)).toEqual(['paragraph.'])
  })
})

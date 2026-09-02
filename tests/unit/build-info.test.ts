import { describe, expect, it } from 'vitest'
import { formatBuildVersion, shortCommit } from '../../shared/utils/build-info'

describe('formatBuildVersion', () => {
  it('names the tag and the commit together', () => {
    // Between two tags the tag alone cannot say which build off main this is.
    expect(formatBuildVersion({ version: '0.3.0', commit: '1a2b3c4d5e6f7a8b9c0d' })).toBe('v0.3.0 (1a2b3c4)')
  })

  it('shows the version alone when the builder did not know the commit', () => {
    expect(formatBuildVersion({ version: '0.3.0', commit: '' })).toBe('v0.3.0')
  })

  it('shows the commit alone when there is no version', () => {
    expect(formatBuildVersion({ version: '', commit: 'abcdef0123' })).toBe('abcdef0')
  })

  it('says unknown rather than inventing a value', () => {
    expect(formatBuildVersion(null)).toBe('unknown')
    expect(formatBuildVersion({})).toBe('unknown')
    expect(formatBuildVersion({ version: '  ', commit: ' ' })).toBe('unknown')
  })
})

describe('shortCommit', () => {
  it('keeps the seven characters a git log shows', () => {
    expect(shortCommit(' 1a2b3c4d5e6f ')).toBe('1a2b3c4')
    expect(shortCommit(undefined)).toBe('')
  })
})

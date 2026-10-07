import { describe, expect, it } from 'vitest'
import { normalizeHttpUrl, onlyHttpUrl } from '../../server/utils/http-url'

const HOSTILE = [
  'javascript:alert(1)',
  'JavaScript:alert(1)',
  '  javascript:alert(1)',
  'jav\tascript:alert(1)',
  'data:text/html,<script>alert(1)</script>',
  'vbscript:msgbox(1)',
  'file:///etc/passwd',
  '//evil.example/x',
  '/relative',
  'ada.dev',
  '',
]

describe('normalizeHttpUrl (writes)', () => {
  it('keeps an absolute http(s) address in canonical form', () => {
    expect(normalizeHttpUrl('https://ada.dev')).toBe('https://ada.dev/')
    expect(normalizeHttpUrl('  http://ada.dev/a?b=1  ')).toBe('http://ada.dev/a?b=1')
  })

  it.each(HOSTILE)('rejects %j', (value) => {
    expect(normalizeHttpUrl(value)).toBeNull()
  })

  it('treats null and undefined as no address and caps the length at 2048', () => {
    expect(normalizeHttpUrl(null)).toBeNull()
    expect(normalizeHttpUrl(undefined)).toBeNull()
    expect(normalizeHttpUrl(`https://ada.dev/${'a'.repeat(3000)}`)).toHaveLength(2048)
  })
})

describe('onlyHttpUrl (reads)', () => {
  it('returns a stored http(s) address exactly as it is, not re-serialized', () => {
    expect(onlyHttpUrl('https://ada.dev')).toBe('https://ada.dev')
    expect(onlyHttpUrl('http://ada.dev/a?b=1')).toBe('http://ada.dev/a?b=1')
  })

  it.each(HOSTILE)('returns null for %j', (value) => {
    expect(onlyHttpUrl(value)).toBeNull()
  })

  it('returns null for null and undefined', () => {
    expect(onlyHttpUrl(null)).toBeNull()
    expect(onlyHttpUrl(undefined)).toBeNull()
  })
})

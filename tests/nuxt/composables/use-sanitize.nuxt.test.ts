import { describe, expect, it } from 'vitest'
import { useSanitize } from '../../../app/composables/useSanitize'

describe('useSanitize', () => {
  it('removes dangerous script and inline event handler markup', () => {
    const { sanitize } = useSanitize()

    const html = sanitize('<p>Hello</p><img src="x" onerror="alert(1)"><script>alert(1)</script>')

    expect(html).toContain('<p>Hello</p>')
    expect(html).not.toContain('onerror')
    expect(html).not.toContain('<script>')
  })
})

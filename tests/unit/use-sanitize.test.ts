// @vitest-environment jsdom
//
// Runs under jsdom rather than the nuxt project's happy-dom environment.
// DOMPurify 3.4.x's hardened DOM handling is incompatible with happy-dom 20.x —
// the sanitizer silently passes dangerous markup through there (verified across
// happy-dom 20.9.0–20.10.6), even though it sanitizes correctly in real browsers.
// jsdom is DOMPurify's recommended non-browser environment. `useSanitize` has no
// Nuxt runtime dependencies, so it doesn't need the nuxt test environment.
import { describe, expect, it } from 'vitest'
import { useSanitize } from '../../app/composables/useSanitize'

describe('useSanitize', () => {
  it('removes dangerous script and inline event handler markup', () => {
    const { sanitize } = useSanitize()

    const html = sanitize('<p>Hello</p><img src="x" onerror="alert(1)"><script>alert(1)</script>')

    expect(html).toContain('<p>Hello</p>')
    expect(html).not.toContain('onerror')
    expect(html).not.toContain('<script>')
  })
})

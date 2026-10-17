import { describe, expect, it } from 'vitest'
import { escapeHtml, renderEmail, rich } from '../../server/utils/email-layout'
import type { EmailChrome, EmailEnv } from '../../server/utils/email-layout'

const chrome: EmailChrome = {
  logoAlt: 'Contentrain Studio',
  thanks: 'Thanks,',
  team: 'The Contentrain team',
  linkWebsite: 'Website',
  linkProduct: 'Studio',
  linkGitHub: 'GitHub',
  linkLinkedIn: 'LinkedIn',
  linkX: 'X',
  aboutLine: 'This email is about {about}.',
  aboutDefault: 'your account',
  privacy: 'Privacy',
  productLine: '{product} is a Contentrain product.',
  productName: 'Studio',
}
const env: EmailEnv = {
  siteUrl: 'https://studio.example.com/',
  websiteUrl: 'https://contentrain.io',
  githubUrl: 'https://github.com/Contentrain',
  linkedinUrl: 'https://www.linkedin.com/company/contentrain',
  xUrl: 'https://x.com/Contentrain_io',
  privacyUrl: 'https://contentrain.io/legal/privacy-policy',
}

describe('rich', () => {
  it('escapes literal text and params, and renders bold, code and links from the template only', () => {
    const r = rich('Hi **{name}**, run `{cmd}` or [open it]({link}).', { name: '<img src=x onerror=1>', cmd: 'a && b', link: 'https://example.com/a?b=1&c=2' })
    expect(r.html).toBe('Hi <strong>&lt;img src=x onerror=1&gt;</strong>, run <code>a &amp;&amp; b</code> or <a href="https://example.com/a?b=1&amp;c=2" style="color:#0F172A;font-weight:600;text-decoration:underline;">open it</a>.')
    expect(r.text).toBe('Hi <img src=x onerror=1>, run a && b or open it: https://example.com/a?b=1&c=2.')
  })

  it('never turns a user value into markup or a link', () => {
    const r = rich('{name}', { name: '**bold** `code` [x](https://evil.test)' })
    expect(r.html).toBe('**bold** `code` [x](https://evil.test)')
  })

  it('renders a link param that is not an absolute http(s) URL as plain label text', () => {
    expect(rich('[go]({u})', { u: 'javascript:alert(1)' }).html).toBe('go')
  })

  it('leaves an unknown {param} empty instead of printing it', () => {
    expect(rich('a{missing}b', {}).text).toBe('ab')
  })
})

describe('renderEmail', () => {
  const parts = {
    heading: rich('Payment received for {site}', { site: '<b>x</b>.com' }),
    preheader: rich('Preview'),
    lead: rich('We got it.'),
    facts: [{ label: 'Amount', value: rich('490 USD') }],
    quote: 'a < b\nsecond line',
    cta: { label: 'Open', url: 'https://studio.example.com/w/acme?x=1&y=2' },
    notes: [rich('Note one.'), rich('Note two.')],
    about: 'your billing',
  }

  it('produces the shared layout: logo, heading, facts, quote, button, notes, sign-off, footer', () => {
    const { html } = renderEmail(parts, chrome, env)
    expect(html).toContain('<meta name="color-scheme" content="light only">')
    expect(html).toContain('width="600"')
    expect(html).toContain('<img src="https://studio.example.com/email/logo.png" width="159" height="30" alt="Contentrain Studio"')
    expect(html).toContain('Payment received for &lt;b&gt;x&lt;/b&gt;.com')
    expect(html).toContain('bgcolor="#0331FC"')
    expect(html).toContain('href="https://studio.example.com/w/acme?x=1&amp;y=2"')
    expect(html).toContain('a &lt; b<br>second line')
    expect(html).toContain('Thanks,')
    expect(html).toContain('The Contentrain team')
    expect(html).toContain('This email is about your billing.')
    expect(html).toContain('Studio is a Contentrain product.')
    expect(html).toContain('href="https://contentrain.io/legal/privacy-policy"')
    expect(html).not.toContain('data:image')
  })

  it('has a plain-text alternative with the same content and absolute links', () => {
    const { text } = renderEmail(parts, chrome, env)
    expect(text).toContain('Payment received for <b>x</b>.com')
    expect(text).toContain('Amount: 490 USD')
    expect(text).toContain('> a < b\n> second line')
    expect(text).toContain('Open: https://studio.example.com/w/acme?x=1&y=2')
    expect(text).toContain('Thanks,\nThe Contentrain team')
    expect(text).toContain('Privacy: https://contentrain.io/legal/privacy-policy')
    expect(text).not.toMatch(/<(p|a|table|td)\b/)
  })

  it('omits the sign-off for emails to ourselves and the optional blocks when absent', () => {
    const { html } = renderEmail({ heading: rich('Internal'), signoff: false }, chrome, env)
    expect(html).not.toContain('The Contentrain team')
    expect(html).not.toContain('fact-k" style')
    expect(html).toContain('This email is about your account.')
  })

  it('links Website / Studio / GitHub / LinkedIn / X in one row, in html and text', () => {
    const { html, text } = renderEmail(parts, chrome, env)
    const row = html.match(/<p style="margin:0 0 20px;">([\s\S]*?)<\/p>/)![1]!
    expect([...row.matchAll(/href="([^"]+)"/g)].map(m => m[1])).toEqual([
      'https://contentrain.io',
      'https://studio.example.com',
      'https://github.com/Contentrain',
      'https://www.linkedin.com/company/contentrain',
      'https://x.com/Contentrain_io',
    ])
    expect(text).toContain('LinkedIn: https://www.linkedin.com/company/contentrain\nX: https://x.com/Contentrain_io')
  })

  it('leaves an unset social link out of the row instead of rendering it empty', () => {
    const { html, text } = renderEmail(parts, chrome, { ...env, linkedinUrl: '', xUrl: undefined })
    expect(html).not.toContain('LinkedIn')
    expect(html).not.toContain('>X<')
    expect(html).not.toContain('href=""')
    expect(text).not.toMatch(/^(LinkedIn|X):/m)
  })

  it('escapes the helper the same way for attributes', () => {
    expect(escapeHtml(`"'<&>`)).toBe('&quot;&#39;&lt;&amp;&gt;')
  })
})

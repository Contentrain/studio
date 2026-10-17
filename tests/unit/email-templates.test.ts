import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { emailTemplate } from '../../server/utils/content-strings'
import { EMAIL_SAMPLES } from '../helpers/email-samples'

/**
 * Renders every `email-templates` entry through the real dictionary and layout.
 *
 * Also the writer behind two scripts (they are not tests of their own):
 *   EMAIL_PREVIEW_DIR=<dir>   writes every email as <dir>/<slug>.html + .txt  (`pnpm email:previews`)
 *   EMAIL_SUPABASE_WRITE=1    rewrites supabase/templates/*.html               (`pnpm email:supabase`)
 */
const SITE = 'https://studio.example.com'
const SUPABASE_SITE = 'https://supabase-site.invalid'
const SUPABASE_URL = 'https://supabase-url.invalid/confirm'

let site = SITE
let replyTo = ''
beforeAll(() => {
  vi.stubGlobal('useRuntimeConfig', () => ({
    public: { siteUrl: site },
    emailReplyTo: replyTo,
    emailLinks: { websiteUrl: 'https://contentrain.io', githubUrl: 'https://github.com/Contentrain', privacyUrl: 'https://contentrain.io/legal/privacy-policy' },
  }))
})

const slugs = Object.keys(EMAIL_SAMPLES)

describe('email templates', () => {
  it('has a sample for every template in the dictionary, and a template for every sample', () => {
    const file = JSON.parse(readFileSync('.contentrain/content/system/email-templates/en.json', 'utf8')) as Record<string, { slug: string }>
    expect(Object.values(file).map(e => e.slug).sort()).toEqual([...slugs].sort())
  })

  it.each(slugs)('%s renders html + text with a subject, absolute links and nothing unfilled', (slug) => {
    const sample = EMAIL_SAMPLES[slug]!
    const out = emailTemplate(slug, sample.params, 'en', sample.facts ? { facts: sample.facts } : undefined)
    expect(out.subject).not.toBe(slug)
    expect(out.subject).not.toMatch(/[{}\n]/)
    expect(out.html).toContain('<img src="https://studio.example.com/email/logo.png"')
    expect(out.html).toContain('alt="Contentrain Studio"')
    expect(out.html).toContain('Thanks,')
    expect(out.html).not.toMatch(/\{\w+\}/)
    expect(out.text).not.toMatch(/\{\w+\}/)
    expect(out.text.length).toBeGreaterThan(40)
    expect(out.text).not.toMatch(/<\/?(p|a|td|table|strong)\b/)
    for (const [, href] of out.html.matchAll(/href="([^"]*)"/g)) expect(href).toMatch(/^https?:\/\//)
    expect(out.text).toContain('https://contentrain.io/legal/privacy-policy')
  })

  it('shows the button URL in the text part', () => {
    const out = emailTemplate('auth-magic-link', EMAIL_SAMPLES['auth-magic-link']!.params)
    expect(out.text).toContain('Sign in: https://studio.example.com/api/auth/magic/verify?token=abc&redirect=%2F')
    expect(out.html).toContain('href="https://studio.example.com/api/auth/magic/verify?token=abc&amp;redirect=%2F"')
  })

  it('escapes user values everywhere they land: heading, lead, facts, quote', () => {
    const evil = '<script>alert(1)</script>'
    const hook = emailTemplate('webhook-dlq-alert', { ...EMAIL_SAMPLES['webhook-dlq-alert']!.params, webhookName: evil, webhookUrl: evil, workspaceName: evil, recipientName: evil })
    expect(hook.html).not.toContain('<script>')
    expect(hook.html).toContain('&lt;script&gt;')
    const comment = emailTemplate('comment-pending', { ...EMAIL_SAMPLES['comment-pending']!.params, excerpt: evil, authorName: evil, projectName: evil })
    expect(comment.html).not.toContain('<script>')
    const form = emailTemplate('form-submitted', EMAIL_SAMPLES['form-submitted']!.params, 'en', { facts: [{ label: evil, value: evil }] })
    expect(form.html).not.toContain('<script>')
    expect(form.html).toContain('&lt;script&gt;')
  })

  it('keeps a user value out of the subject headers: no line breaks', () => {
    const out = emailTemplate('webhook-dlq-alert', { ...EMAIL_SAMPLES['webhook-dlq-alert']!.params, webhookName: 'a\r\nBcc: x@evil.test' })
    expect(out.subject).not.toMatch(/[\r\n]/)
  })

  it('drops the button instead of linking a relative or script URL', () => {
    const out = emailTemplate('payment-recovered', { ...EMAIL_SAMPLES['payment-recovered']!.params, billingUrl: '/w/acme/settings?tab=billing' })
    expect(out.html).not.toContain('bgcolor="#0331FC"')
    const js = emailTemplate('payment-recovered', { ...EMAIL_SAMPLES['payment-recovered']!.params, billingUrl: 'javascript:alert(1)' })
    expect(js.html).not.toContain('javascript:')
  })

  const REPLY_SLUGS = ['payment-failed', 'subscription-activated', 'subscription-cancel-scheduled', 'subscription-canceled', 'trial-ending']

  it.each(REPLY_SLUGS)('%s invites no reply when NUXT_EMAIL_REPLY_TO is unset', (slug) => {
    const out = emailTemplate(slug, EMAIL_SAMPLES[slug]!.params)
    expect(out.html).not.toMatch(/reply to this email/i)
    expect(out.text).not.toMatch(/reply to this email/i)
    expect(out.text).toContain('Thanks,')
  })

  it.each(REPLY_SLUGS)('%s invites a reply when NUXT_EMAIL_REPLY_TO is set', (slug) => {
    replyTo = 'support@studio.example.com'
    try {
      const out = emailTemplate(slug, EMAIL_SAMPLES[slug]!.params)
      expect(out.html).toMatch(/reply to this email/i)
      expect(out.text).toMatch(/reply to this email/i)
    }
    finally { replyTo = '' }
  })

  it('no template invites a reply outside the reply field', () => {
    const file = JSON.parse(readFileSync('.contentrain/content/system/email-templates/en.json', 'utf8')) as Record<string, Record<string, string>>
    for (const entry of Object.values(file)) {
      for (const [key, value] of Object.entries(entry)) {
        if (key !== 'reply') expect(value, `${entry.slug}.${key}`).not.toMatch(/reply to this email/i)
      }
    }
    expect(Object.values(file).filter(e => e.reply).map(e => e.slug).sort()).toEqual([...REPLY_SLUGS].sort())
  })
})

describe.runIf(process.env.EMAIL_PREVIEW_DIR)('previews', () => {
  it('writes every email', () => {
    const dir = process.env.EMAIL_PREVIEW_DIR!
    mkdirSync(dir, { recursive: true })
    const rows: string[] = []
    for (const slug of slugs.filter(s => !s.startsWith('supabase-'))) {
      const sample = EMAIL_SAMPLES[slug]!
      const out = emailTemplate(slug, sample.params, 'en', sample.facts ? { facts: sample.facts } : undefined)
      // Local previews load the logo from the folder; sent emails use the absolute https URL.
      writeFileSync(join(dir, `${slug}.html`), out.html.replaceAll(`${SITE}/email/logo.png`, 'logo.png'))
      writeFileSync(join(dir, `${slug}.txt`), `Subject: ${out.subject}\n\n${out.text}\n`)
      rows.push(`<li><a href="${slug}.html">${slug}</a> &mdash; ${out.subject.replace(/</g, '&lt;')}</li>`)
    }
    copyFileSync('public/email/logo.png', join(dir, 'logo.png'))
    writeFileSync(join(dir, 'index.html'), `<!doctype html><meta charset="utf-8"><title>Studio emails</title><body style="font-family:sans-serif"><h1>Studio emails</h1><ul>${rows.join('')}</ul>`)
    expect(rows.length).toBeGreaterThan(10)
  })
})

/**
 * Supabase Auth sends magic link / invite / confirmation itself, from
 * `supabase/templates/*.html`. They are generated from the same layout: the app URL
 * becomes `{{ .SiteURL }}` and the button `{{ .ConfirmationURL }}` (Supabase's Go
 * template variables). The test fails when a committed template has drifted.
 */
const SUPABASE_FILES: Array<[string, string]> = [
  ['supabase-confirmation', 'confirmation.html'],
  ['supabase-invite', 'invite.html'],
  ['supabase-magic-link', 'magic-link.html'],
]

describe('supabase auth templates', () => {
  it.each(SUPABASE_FILES)('%s is up to date in supabase/templates/%s', (slug, file) => {
    site = SUPABASE_SITE
    const out = emailTemplate(slug, { url: SUPABASE_URL })
    site = SITE
    const html = out.html.replaceAll(SUPABASE_URL, '{{ .ConfirmationURL }}').replaceAll(SUPABASE_SITE, '{{ .SiteURL }}')
    expect(html).toContain('{{ .ConfirmationURL }}')
    expect(html).toContain('{{ .SiteURL }}/email/logo.png')
    expect(html).not.toContain('.invalid')
    const path = join('supabase/templates', file)
    if (process.env.EMAIL_SUPABASE_WRITE) writeFileSync(path, html)
    expect(readFileSync(path, 'utf8')).toBe(html)
  })
})

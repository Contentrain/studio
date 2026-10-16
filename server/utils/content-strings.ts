/**
 * Server-side content string reader.
 *
 * Uses @contentrain/query SDK to read dictionary models
 * (agent-prompts, agent-messages, error-messages) for server routes and system prompts.
 *
 * SDK reads from pre-generated .contentrain/client/ — synchronous, zero I/O.
 */

import { dictionary, query } from '#contentrain'
import { renderEmail, rich } from './email-layout'
import type { EmailChrome, EmailEnv } from './email-layout'
import { featurePlanParams } from '../../shared/utils/license'

type Params = Record<string, string | number>

function interpolate(template: string, params?: Params): string {
  // `{plans:<feature>}` — which plans grant a feature, from the catalog, so
  // no string hard-codes plan availability (BG-1 P1-14). Explicit params win.
  if (template.includes('{plans:')) params = { ...featurePlanParams(), ...params }
  if (!params) return template
  let result = template
  for (const [k, v] of Object.entries(params)) {
    result = result.replaceAll(`{${k}}`, String(v))
  }
  return result
}

/**
 * Get a string from agent-prompts dictionary.
 * Used in buildSystemPrompt() for plan descriptions, feature guides, etc.
 */
export function agentPrompt(key: string, params?: Params, locale: string = 'en'): string {
  try {
    const value = dictionary('agent-prompts').locale(locale).get(key) ?? key
    return interpolate(value, params)
  }
  catch {
    return key
  }
}

/**
 * Get a string from agent-messages dictionary.
 * Used in agent tool results for user-facing response messages.
 */
export function agentMessage(key: string, params?: Params, locale: string = 'en'): string {
  try {
    const value = dictionary('agent-messages').locale(locale).get(key) ?? key
    return interpolate(value, params)
  }
  catch {
    return key
  }
}

/**
 * Get a string from error-messages dictionary.
 * Used in createError() responses across all server routes.
 */
export function errorMessage(key: string, params?: Params, locale: string = 'en'): string {
  try {
    const value = dictionary('error-messages').locale(locale).get(key) ?? key
    return interpolate(value, params)
  }
  catch {
    return key
  }
}

/** Layout chrome (sign-off, footer labels) from the `ui-strings` dictionary. */
function emailChrome(locale: string): EmailChrome {
  const get = (key: string): string => {
    try {
      return dictionary('ui-strings').locale(locale).get(key) ?? key
    }
    catch {
      return key
    }
  }
  return {
    logoAlt: get('email.logo_alt'),
    thanks: get('email.thanks'),
    team: get('email.team'),
    linkWebsite: get('email.link_website'),
    linkProduct: get('email.link_product'),
    linkGitHub: get('email.link_github'),
    aboutLine: get('email.about_line'),
    aboutDefault: get('email.about_default'),
    privacy: get('email.privacy'),
    productLine: get('email.product_line'),
    productName: get('email.product_name'),
  }
}

/** Absolute links of the layout, from runtime config; `emailLinks` in nuxt.config.ts holds the defaults. */
function emailEnv(): EmailEnv {
  const config = useRuntimeConfig()
  const links = (config.emailLinks ?? {}) as { websiteUrl?: string, githubUrl?: string, privacyUrl?: string }
  return {
    siteUrl: String((config.public as { siteUrl?: string } | undefined)?.siteUrl ?? ''),
    websiteUrl: links.websiteUrl ?? '',
    githubUrl: links.githubUrl ?? '',
    privacyUrl: links.privacyUrl ?? '',
  }
}

/** One-line subject: no line breaks, so a user value can never add a header. */
function oneLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

interface EmailTemplateEntry {
  subject?: string
  preheader?: string
  heading?: string
  lead?: string
  facts?: string
  quote?: string
  cta_label?: string
  cta_url?: string
  notes?: string
  about?: string
}

export interface RenderedTemplate {
  subject: string
  html: string
  text: string
}

/**
 * Render one email from the email-templates collection through the shared layout.
 *
 * `params` are always escaped; copy never carries HTML. `cta_url` and `quote` are
 * single `{param}` references whose values are filled here: the URL only becomes a
 * link if it is an absolute http(s) URL, and the quote is the user's text, shown as-is.
 * `extras.facts` appends rows built in code from user data (form fields); label and
 * value are plain text and escaped.
 */
export function emailTemplate(
  slug: string,
  params?: Params,
  locale: string = 'en',
  extras?: { facts?: Array<{ label: string, value: string }> },
): RenderedTemplate {
  const fallback = (): RenderedTemplate => ({ subject: slug, html: '', text: '' })
  try {
    const entries = query('email-templates').locale(locale).where('slug', slug).all()
    const entry = entries[0] as EmailTemplateEntry | undefined
    if (!entry) return fallback()
    const p = params ?? {}
    const subject = oneLine(rich(entry.subject ?? slug, p).text)
    const ctaUrl = entry.cta_url ? rich(entry.cta_url, p).text : ''
    const facts = (entry.facts ?? '').split('\n').map(l => l.trim()).filter(Boolean).map((line) => {
      const [label = '', ...rest] = line.split('|')
      return { label, value: rich(rest.join('|'), p) }
    })
    for (const f of extras?.facts ?? []) facts.push({ label: f.label, value: rich('{value}', { value: f.value }) })
    const rendered = renderEmail({
      heading: rich(entry.heading ?? subject, p),
      ...(entry.preheader ? { preheader: rich(entry.preheader, p) } : {}),
      ...(entry.lead ? { lead: rich(entry.lead, p) } : {}),
      ...(facts.length ? { facts } : {}),
      ...(entry.quote ? { quote: rich(entry.quote, p).text } : {}),
      ...(entry.cta_label && /^https?:\/\//i.test(ctaUrl) ? { cta: { label: entry.cta_label, url: ctaUrl } } : {}),
      ...(entry.notes ? { notes: entry.notes.split(/\n{2,}/).map(n => rich(n.trim(), p)) } : {}),
      ...(entry.about ? { about: entry.about } : {}),
    }, emailChrome(locale), emailEnv())
    return { subject, ...rendered }
  }
  catch {
    return fallback()
  }
}

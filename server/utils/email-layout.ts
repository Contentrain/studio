/**
 * The one email layout (BRIEF: email standardisation, 2026-10-16).
 *
 * Every Studio email — auth, invites, billing, usage, forms, comments, webhooks —
 * is rendered by `renderEmail(parts, chrome, env)` and returns `{ html, text }`.
 * Nothing else builds email markup.
 *
 * Layout: table-based, 600px, white, light-only. Logo row → heading → lead →
 * facts → quote → button → rule → notes → sign-off → footer. Email clients do
 * not reliably support external stylesheets, so the markup is inline, with one
 * small `<style>` block for the mobile query. Hex values map to the Studio
 * secondary/primary palette (#0F172A, #334155, #64748B, #94A3B8, #E2E8F0, #0331FC).
 *
 * Safety: nothing here accepts raw HTML. Copy is written as a template
 * (`rich()`), user values are `{params}` that are always HTML-escaped, and the
 * only markup is `**bold**`, `` `code` `` and `[label]({urlParam})`.
 */

/** HTML and plain-text renderings of one piece of copy. */
export interface Rich {
  html: string
  text: string
}

type Params = Record<string, string | number | null | undefined>

const FONT = '-apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,Helvetica,Arial,sans-serif'

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** Only absolute http(s) URLs become links; anything else renders as plain text. */
function safeHref(value: string): string | null {
  return /^https?:\/\/[^\s"'<>]+$/i.test(value) ? value : null
}

// One pass, left to right: [label]({param}) | **bold** | `code` | {param}
const TOKEN = /\[([^\]]+)\]\(\{(\w+)\}\)|\*\*(.+?)\*\*|`([^`]+)`|\{(\w+)\}/g

/**
 * Copy template → `{ html, text }`. Literal text is escaped; `{param}` values are
 * escaped; a user value is never interpreted as markup or as a link.
 */
export function rich(template: string, params: Params = {}): Rich {
  const value = (key: string): string => {
    const v = params[key]
    return v === null || v === undefined ? '' : String(v)
  }
  let html = ''
  let text = ''
  let last = 0
  for (const m of template.matchAll(TOKEN)) {
    const literal = template.slice(last, m.index)
    html += escapeHtml(literal)
    text += literal
    last = (m.index ?? 0) + m[0].length
    if (m[1] !== undefined && m[2] !== undefined) {
      const href = safeHref(value(m[2]))
      html += href
        ? `<a href="${escapeHtml(href)}" style="color:#0F172A;font-weight:600;text-decoration:underline;">${escapeHtml(m[1])}</a>`
        : escapeHtml(m[1])
      text += href ? `${m[1]}: ${href}` : m[1]
    }
    else if (m[3] !== undefined) {
      const inner = rich(m[3], params)
      html += `<strong>${inner.html}</strong>`
      text += inner.text
    }
    else if (m[4] !== undefined) {
      const inner = rich(m[4], params)
      html += `<code>${inner.html}</code>`
      text += inner.text
    }
    else if (m[5] !== undefined) {
      html += escapeHtml(value(m[5]))
      text += value(m[5])
    }
  }
  const rest = template.slice(last)
  html += escapeHtml(rest)
  text += rest
  return { html, text }
}

/** Fixed labels and links of the layout; the copy lives in the `ui-strings` dictionary. */
export interface EmailChrome {
  logoAlt: string
  thanks: string
  team: string
  linkWebsite: string
  linkProduct: string
  linkGitHub: string
  linkLinkedIn: string
  linkX: string
  /** Template with `{about}`, e.g. "This email is about {about}." */
  aboutLine: string
  /** Used when a template names no subject of its own. */
  aboutDefault: string
  privacy: string
  /** Template with `{product}`, e.g. "{product} is a Contentrain product." */
  productLine: string
  productName: string
}

/** Where the layout links and loads its logo from. All absolute. */
export interface EmailEnv {
  /** Public base URL of the app (`runtimeConfig.public.siteUrl`). */
  siteUrl: string
  websiteUrl: string
  githubUrl: string
  /** Footer social links; an empty one is left out of the row. */
  linkedinUrl?: string
  xUrl?: string
  privacyUrl: string
  logoWidth?: number
  logoHeight?: number
}

export interface EmailFact {
  label: string
  value: Rich
}

export interface EmailParts {
  heading: Rich
  /** Hidden inbox preview text. */
  preheader?: Rich
  lead?: Rich
  facts?: EmailFact[]
  /** A user's own words (comment text), rendered as a quote and never interpreted. */
  quote?: string
  cta?: { label: string, url: string }
  /** Secondary paragraphs, below the rule. */
  notes?: Rich[]
  /** What the email is about, for the footer line (plain text). */
  about?: string
  /** `false` for emails to ourselves; default `true`. */
  signoff?: boolean
}

export interface RenderedEmail {
  html: string
  text: string
}

const base = (extra: string): string => `font-family:${FONT};${extra}`
const trim = (s: string): string => s.replace(/\/+$/, '')

export function logoUrlOf(env: Pick<EmailEnv, 'siteUrl'>): string {
  return `${trim(env.siteUrl)}/email/logo.png`
}

const LOGO_W = 159
const LOGO_H = 30

function p(content: string, style: string): string {
  return `<p style="margin:0 0 16px;${base(style)}">${content}</p>`
}

function factsTable(facts: EmailFact[]): string {
  const cell = (inner: string, key: boolean): string =>
    `<td valign="top"${key ? ' class="fact-k"' : ''} style="padding:10px 12px;border-top:1px solid #E2E8F0;${base(key ? 'font-size:13px;line-height:20px;color:#64748B;width:110px;' : 'font-size:14px;line-height:20px;color:#0F172A;')}">${inner}</td>`
  const rows = facts.map(f => `<tr>${cell(escapeHtml(f.label), true)}${cell(f.value.html, false)}</tr>`).join('\n')
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 16px;border-bottom:1px solid #E2E8F0;">${rows}</table>`
}

function button(label: string, url: string): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:24px 0 8px;"><tr>
<td bgcolor="#0331FC" style="border-radius:6px;">
<a href="${escapeHtml(url)}" style="display:inline-block;padding:12px 20px;${base('font-size:15px;font-weight:600;line-height:20px;color:#FFFFFF;text-decoration:none;border-radius:6px;')}">${escapeHtml(label)}</a>
</td></tr></table>`
}

const RULE = '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:32px 0 24px;"><tr><td height="1" bgcolor="#E2E8F0" style="height:1px;line-height:1px;font-size:0;background:#E2E8F0;">&nbsp;</td></tr></table>'

export function renderEmail(parts: EmailParts, chrome: EmailChrome, env: EmailEnv): RenderedEmail {
  const home = trim(env.siteUrl)
  const about = rich(chrome.aboutLine, { about: parts.about ?? chrome.aboutDefault })
  const product = rich(chrome.productLine, { product: chrome.productName })
  const signoff = parts.signoff !== false

  const body: string[] = []
  body.push(`<h1 style="margin:0 0 16px;${base('font-size:20px;line-height:28px;font-weight:700;color:#0F172A;')}">${parts.heading.html}</h1>`)
  if (parts.lead) body.push(p(parts.lead.html, 'font-size:17px;line-height:28px;color:#0F172A;'))
  if (parts.facts?.length) body.push(factsTable(parts.facts))
  if (parts.quote) {
    body.push(`<blockquote style="margin:8px 0 16px;padding:4px 0 4px 16px;border-left:3px solid #E2E8F0;${base('font-size:15px;line-height:26px;color:#334155;')}">${escapeHtml(parts.quote).replace(/\r?\n/g, '<br>')}</blockquote>`)
  }
  if (parts.cta) body.push(button(parts.cta.label, parts.cta.url))
  if (parts.notes?.length) {
    body.push(RULE)
    for (const n of parts.notes) body.push(p(n.html, 'font-size:15px;line-height:26px;color:#64748B;'))
  }
  if (signoff) {
    body.push(`<p style="margin:24px 0 4px;${base('font-size:15px;line-height:24px;color:#64748B;')}">${escapeHtml(chrome.thanks)}</p>`)
    body.push(`<p style="margin:0 0 40px;${base('font-size:15px;line-height:24px;font-weight:600;color:#334155;')}">${escapeHtml(chrome.team)}</p>`)
  }

  const link = (label: string, href: string): string =>
    `<a href="${escapeHtml(href)}" style="color:#0F172A;font-weight:600;text-decoration:underline;">${escapeHtml(label)}</a>`
  // Website / Studio / GitHub / LinkedIn / X — a link with no URL is left out, never rendered empty.
  const footerLinks = ([
    [chrome.linkWebsite, env.websiteUrl],
    [chrome.linkProduct, home],
    [chrome.linkGitHub, env.githubUrl],
    [chrome.linkLinkedIn, env.linkedinUrl ?? ''],
    [chrome.linkX, env.xUrl ?? ''],
  ] as Array<[string, string]>).filter(([, href]) => href)
  const sep = ' <span style="color:#94A3B8;">/</span> '
  const preheader = parts.preheader
    ? `<div style="display:none;max-height:0;overflow:hidden;opacity:0;mso-hide:all;">${parts.preheader.html}${'&#8203;&#847;'.repeat(8)}</div>`
    : ''

  const html = `<!doctype html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<meta name="format-detection" content="telephone=no,address=no,email=no,date=no">
<meta name="color-scheme" content="light only">
<title>${escapeHtml(parts.heading.text)}</title>
<style>
  @media (max-width:620px) {
    .container { width:100% !important; }
    .px { padding-left:20px !important; padding-right:20px !important; }
    .fact-k { width:96px !important; }
  }
  a { color:#0F172A; }
  code { font-family:SFMono-Regular,Menlo,Consolas,'Courier New',monospace; font-size:13px; }
</style>
</head>
<body style="margin:0;padding:0;background:#FFFFFF;">
${preheader}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#FFFFFF" style="background:#FFFFFF;">
<tr><td align="center" style="padding:24px 12px 40px;">
  <table role="presentation" class="container" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:600px;">

    <tr><td class="px" style="padding:0 24px 24px;">
      <a href="${escapeHtml(home)}" style="text-decoration:none;">
        <img src="${escapeHtml(logoUrlOf(env))}" width="${env.logoWidth ?? LOGO_W}" height="${env.logoHeight ?? LOGO_H}" alt="${escapeHtml(chrome.logoAlt)}" style="display:block;border:0;outline:none;height:auto;max-width:${env.logoWidth ?? LOGO_W}px;">
      </a>
    </td></tr>

    <tr><td class="px" style="padding:0 24px;">
${body.join('\n')}
    </td></tr>

    <tr><td class="px" style="padding:0 24px;${base('font-size:14px;line-height:22px;color:#64748B;')}">
      <p style="margin:0 0 20px;">
        ${footerLinks.map(([label, href]) => link(label, href)).join(sep)}
      </p>
      <p style="margin:0;font-size:12px;line-height:18px;color:#94A3B8;">
        ${about.html}
        <a href="${escapeHtml(env.privacyUrl)}" style="color:#94A3B8;">${escapeHtml(chrome.privacy)}</a>
      </p>
      <p style="margin:16px 0 0;padding-top:16px;border-top:1px solid #E2E8F0;font-size:12px;line-height:18px;color:#64748B;">${product.html} <a href="${escapeHtml(env.websiteUrl)}" style="color:#64748B;">${escapeHtml(env.websiteUrl.replace(/^https?:\/\//, ''))}</a></p>
    </td></tr>

  </table>
</td></tr>
</table>
</body>
</html>
`

  const textParts: string[] = [parts.heading.text]
  if (parts.lead) textParts.push(parts.lead.text)
  if (parts.facts?.length) textParts.push(parts.facts.map(f => `${f.label}: ${f.value.text}`).join('\n'))
  if (parts.quote) textParts.push(parts.quote.split(/\r?\n/).map(l => `> ${l}`).join('\n'))
  if (parts.cta) textParts.push(`${parts.cta.label}: ${parts.cta.url}`)
  for (const n of parts.notes ?? []) textParts.push(n.text)
  if (signoff) textParts.push(`${chrome.thanks}\n${chrome.team}`)
  textParts.push([
    '--',
    ...footerLinks.map(([label, href]) => `${label}: ${href}`),
    `${about.text} ${chrome.privacy}: ${env.privacyUrl}`,
    product.text,
  ].join('\n'))

  return { html, text: textParts.join('\n\n') }
}

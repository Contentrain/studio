/**
 * Shared HTML chrome for application-level emails.
 *
 * Matches the visual language of the Supabase Auth templates in
 * `supabase/templates/*.html` — kept as code so the two worlds
 * (Supabase-owned auth emails + Studio EmailProvider emails) render
 * from a single source of truth. Email clients do not reliably
 * support `<style>` blocks or external stylesheets, so everything
 * is inline.
 *
 * Brand tokens mirror the Studio palette:
 *   page bg      #f8fafc (secondary-50)
 *   card bg      #ffffff
 *   border       #e2e8f0 (secondary-200)
 *   heading      #0f172a (secondary-900)
 *   body         #475569 (secondary-600)
 *   muted        #94a3b8 (secondary-400)
 *   brand        #4B6BFB (primary-500, Contentrain blue)
 */

export interface EmailLayoutOptions {
  /** H1 shown at the top of the card body — usually the email subject. */
  title: string
  /** Inner HTML — paragraphs, links, tables. Inline styles only. */
  body: string
  /** Hidden preheader text rendered as the preview snippet in inbox lists. */
  preheader?: string
}

export function wrapEmailHtml(options: EmailLayoutOptions): string {
  const { title, body, preheader } = options
  const preheaderBlock = preheader
    ? `<div style="display:none;max-height:0;overflow:hidden;font-size:1px;line-height:1px;color:#f8fafc;opacity:0;">${escapeHtml(preheader)}</div>`
    : ''

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)}</title>
</head>
<body style="margin:0;padding:0;background-color:#f8fafc;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;">
  ${preheaderBlock}
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f8fafc;padding:40px 0;">
    <tr>
      <td align="center">
        <table role="presentation" width="480" cellpadding="0" cellspacing="0" style="background-color:#ffffff;border-radius:12px;border:1px solid #e2e8f0;overflow:hidden;">
          <tr>
            <td style="padding:32px 32px 24px;text-align:center;">
              <div style="font-size:24px;font-weight:700;color:#0f172a;letter-spacing:-0.5px;">
                Contentrain Studio
              </div>
            </td>
          </tr>
          <tr>
            <td style="padding:0 32px 32px;font-size:15px;line-height:1.6;color:#475569;">
              <h1 style="margin:0 0 12px;font-size:20px;font-weight:600;color:#0f172a;">
                ${escapeHtml(title)}
              </h1>
              ${body}
            </td>
          </tr>
          <tr>
            <td style="padding:16px 32px;border-top:1px solid #e2e8f0;text-align:center;">
              <p style="margin:0;font-size:12px;color:#94a3b8;">
                Contentrain Studio &mdash; Git-native content management
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`
}

/**
 * Render a branded CTA button. Use inside email template bodies so
 * every primary action matches the Supabase template button style.
 */
export function emailButton(label: string, href: string): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:24px 0;"><tr><td style="background-color:#4B6BFB;border-radius:8px;"><a href="${escapeAttr(href)}" target="_blank" style="display:inline-block;padding:12px 32px;font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;">${escapeHtml(label)}</a></td></tr></table>`
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function escapeAttr(value: string): string {
  return value.replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

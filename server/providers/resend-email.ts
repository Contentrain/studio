import { Resend } from 'resend'
import type { EmailProvider } from './email'

/**
 * Resend implementation of EmailProvider.
 *
 * Uses Resend API for transactional emails.
 * Requires NUXT_RESEND_API_KEY in runtime config.
 */
export function createResendEmailProvider(apiKey: string): EmailProvider {
  const resend = new Resend(apiKey)
  const defaultFrom = 'Contentrain Studio <noreply@contentrain.io>'

  return {
    async sendEmail(options) {
      await resend.emails.send({
        from: options.from ?? defaultFrom,
        to: options.to,
        subject: options.subject,
        html: options.html,
      })
    },
  }
}

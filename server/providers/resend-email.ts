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
  const config = useRuntimeConfig()
  const senderEmail = (config.emailSenderAddress as string) || 'noreply@contentrain.io'
  const senderName = (config.emailSenderName as string) || 'Contentrain Studio'
  const defaultFrom = `${senderName} <${senderEmail}>`

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

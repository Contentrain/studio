/**
 * Provider-agnostic email interface.
 *
 * Used for application-level emails (workspace invite notifications,
 * resend invites). Auth emails (magic link, invite confirmation) are
 * handled by Supabase's built-in SMTP integration.
 *
 * Current impl: Resend (server/providers/resend-email.ts)
 * Future impls: SendGrid, Postmark, nodemailer (on-premise SMTP)
 */

export interface EmailSendOptions {
  to: string
  subject: string
  html: string
  from?: string
}

export interface EmailProvider {
  sendEmail: (options: EmailSendOptions) => Promise<void>
}

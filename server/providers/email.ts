/**
 * Provider-agnostic email interface.
 *
 * Used for every application-level email (invites, billing, usage alerts,
 * form and comment notifications, webhook alerts, managed-auth magic links).
 * Markup comes from the shared layout (`server/utils/email-layout.ts`).
 * With the Supabase auth provider, magic-link and invite emails are sent by
 * Supabase's own SMTP using `supabase/templates/*.html`, which are generated
 * from the same layout (`pnpm email:templates`).
 *
 * Current impl: Resend (server/providers/resend-email.ts)
 * Future impls: SendGrid, Postmark, nodemailer (on-premise SMTP)
 */

export interface EmailSendOptions {
  to: string
  subject: string
  html: string
  /** Plain-text alternative. Every Studio email carries one. */
  text?: string
  from?: string
}

export interface EmailProvider {
  sendEmail: (options: EmailSendOptions) => Promise<void>
}

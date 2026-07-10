/**
 * Auth email bodies for the managed AuthProvider (magic link, invite).
 *
 * Content-parity ports of supabase/templates/magic-link.html and
 * invite.html — on the postgres pair GoTrue no longer sends these, so they
 * render through the shared email chrome and go out via EmailProvider.
 */
import { emailButton, wrapEmailHtml } from './email-layout'

export function renderMagicLinkEmail(url: string): string {
  return wrapEmailHtml({
    title: 'Sign in to your account',
    preheader: 'Your sign-in link for Contentrain Studio',
    body: `
      <p style="margin:0 0 24px;font-size:15px;line-height:1.6;color:#475569;">
        Click the button below to sign in to Contentrain Studio.
        No password needed.
      </p>
      ${emailButton('Sign In', url)}
      <p style="margin:24px 0 0;font-size:13px;line-height:1.5;color:#94a3b8;">
        This link expires in 1 hour and can only be used once.
        If you didn't request this email, you can safely ignore it.
      </p>
    `,
  })
}

export function renderInviteEmail(url: string): string {
  return wrapEmailHtml({
    title: 'You\'ve been invited',
    preheader: 'Join your team on Contentrain Studio',
    body: `
      <p style="margin:0 0 24px;font-size:15px;line-height:1.6;color:#475569;">
        You've been invited to collaborate on Contentrain Studio.
        Click the button below to accept the invitation and sign in.
      </p>
      ${emailButton('Accept Invitation', url)}
      <p style="margin:24px 0 0;font-size:13px;line-height:1.5;color:#94a3b8;">
        This invitation link expires in 7 days.
        If you weren't expecting this email, you can safely ignore it.
      </p>
    `,
  })
}

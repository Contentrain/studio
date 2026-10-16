/**
 * Sample data for every email the app sends: one entry per `email-templates` slug.
 * Shared by the render tests and by the preview writer (`pnpm email:previews`).
 */
export interface EmailSample {
  params: Record<string, string | number>
  facts?: Array<{ label: string, value: string }>
}

const billingUrl = 'https://studio.example.com/w/acme/settings?tab=billing'

export const EMAIL_SAMPLES: Record<string, EmailSample> = {
  'auth-invite': { params: { url: 'https://studio.example.com/api/auth/magic/verify?token=abc&redirect=%2F' } },
  'auth-magic-link': { params: { url: 'https://studio.example.com/api/auth/magic/verify?token=abc&redirect=%2F' } },
  'invite-added': { params: { inviterName: 'Ada Lovelace', workspaceName: 'Acme Content', workspaceUrl: 'https://studio.example.com/w/acme' } },
  'invite-reminder': { params: { workspaceName: 'Acme Content', workspaceUrl: 'https://studio.example.com/w/acme' } },
  'payment-failed': { params: { workspaceName: 'Acme Content', planName: 'Pro', gracePeriodEndsText: 'October 23, 2026', billingUrl } },
  'payment-recovered': { params: { workspaceName: 'Acme Content', planName: 'Pro', billingUrl } },
  'subscription-activated': { params: { workspaceName: 'Acme Content', planName: 'Pro', planPrice: '$49', billingUrl } },
  'subscription-cancel-scheduled': { params: { workspaceName: 'Acme Content', planName: 'Pro', accessEndsText: 'November 15, 2026', billingUrl } },
  'subscription-canceled': { params: { workspaceName: 'Acme Content', planName: 'Pro', billingUrl } },
  'trial-ending': { params: { workspaceName: 'Acme Content', planName: 'Pro', planPrice: '$49', trialEndsText: 'in 3 days', billingUrl } },
  'webhook-dlq-alert': { params: { recipientName: 'Ada', workspaceName: 'Acme Content', webhookName: 'Deploy hook', webhookUrl: 'https://hooks.example.com/deploy', eventType: 'content.published', settingsUrl: 'https://studio.example.com/w/acme/projects/p1' } },
  'form-submitted': {
    params: { workspaceName: 'Acme Content', projectName: 'Marketing site', modelName: 'Contact', submissionsUrl: 'https://studio.example.com/w/acme/projects/p1' },
    facts: [{ label: 'name', value: 'Ada Lovelace' }, { label: 'email', value: 'ada@example.com' }, { label: 'message', value: 'Hello <b>team</b> & friends' }],
  },
  'usage-warning': { params: { workspaceName: 'Acme Content', planName: 'Pro', meterName: 'AI messages', percentage: 80, used: '800', limit: '1,000', resetLine: 'The count resets on October 31, 2026.', billingUrl } },
  'usage-limit-reached': { params: { workspaceName: 'Acme Content', planName: 'Pro', meterName: 'AI messages', limit: '1,000', consequence: 'Studio AI answers are paused until October 31, 2026.', nextStep: 'To keep going now, change the plan in Billing.', billingUrl } },
  'usage-overage-started': { params: { workspaceName: 'Acme Content', planName: 'Pro', meterName: 'AI messages', limit: '1,000', unitPrice: '$0.05', resetLine: 'The count resets on October 31, 2026.', billingUrl } },
  'comment-pending': { params: { workspaceName: 'Acme Content', projectName: 'Marketing site', modelName: 'posts', entryId: 'hello-world', authorName: 'Grace', excerpt: 'Great post!\nOne note: a < b & c.', moderationUrl: 'https://studio.example.com/w/acme/projects/p1' } },
  'comment-published': { params: { workspaceName: 'Acme Content', projectName: 'Marketing site', modelName: 'posts', entryId: 'hello-world', authorName: 'Grace', excerpt: 'Great post!', moderationUrl: 'https://studio.example.com/w/acme/projects/p1' } },
  'supabase-confirmation': { params: { url: 'https://studio.example.com/auth/confirm' } },
  'supabase-invite': { params: { url: 'https://studio.example.com/auth/invite' } },
  'supabase-magic-link': { params: { url: 'https://studio.example.com/auth/magic' } },
}

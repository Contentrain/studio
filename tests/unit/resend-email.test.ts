import { beforeEach, describe, expect, it, vi } from 'vitest'

const send = vi.fn().mockResolvedValue({ data: { id: 'e1' }, error: null })
vi.mock('resend', () => ({
  Resend: class {
    emails = { send }
  },
}))

let replyTo: string | undefined
vi.stubGlobal('useRuntimeConfig', () => ({ emailSenderAddress: 'noreply@studio.example.com', emailSenderName: 'Studio', emailReplyTo: replyTo }))

const { createResendEmailProvider } = await import('../../server/providers/resend-email')

describe('resend email provider: Reply-To', () => {
  beforeEach(() => send.mockClear())

  it.each([undefined, '', '   '])('sends no Reply-To header when NUXT_EMAIL_REPLY_TO is %j', async (value) => {
    replyTo = value
    await createResendEmailProvider('re_test').sendEmail({ to: 'a@b.test', subject: 'S', html: '<p>x</p>' })
    expect(send).toHaveBeenCalledOnce()
    expect(send.mock.calls[0]![0]).not.toHaveProperty('replyTo')
  })

  it('sends the configured Reply-To header', async () => {
    replyTo = ' support@studio.example.com '
    await createResendEmailProvider('re_test').sendEmail({ to: 'a@b.test', subject: 'S', html: '<p>x</p>' })
    expect(send.mock.calls[0]![0]).toMatchObject({ replyTo: 'support@studio.example.com', from: 'Studio <noreply@studio.example.com>' })
  })
})

import { describe, expect, it, vi } from 'vitest'
import { withTestServer } from '../helpers/http'

async function loadConfig() {
  return (await import('../../server/api/forms/v1/[projectId]/[modelId]/config.get')).default
}
async function loadSubmit() {
  return (await import('../../server/api/forms/v1/[projectId]/[modelId]/submit.post')).default
}

const PROJECT = 'project-1'
const WORKSPACE = 'workspace-1'

function stubFormGlobals(options: {
  form?: Record<string, unknown>
  features?: Record<string, boolean>
  defaultLocale?: string
  siteKey?: string
} = {}) {
  const form = { enabled: true, public: true, exposedFields: ['name', 'email'], honeypot: true, captcha: null, ...options.form }
  const features: Record<string, boolean> = { 'forms.enabled': true, 'forms.captcha': true, 'forms.auto_approve': true, 'forms.notifications': true, 'forms.webhook_notification': false, ...options.features }

  vi.stubGlobal('getRouterParam', vi.fn((_: unknown, key: string) => {
    if (key === 'projectId') return PROJECT
    if (key === 'modelId') return 'contact'
    return undefined
  }))
  vi.stubGlobal('getWorkspacePlan', vi.fn().mockReturnValue('pro'))
  vi.stubGlobal('hasFeature', vi.fn((_: string, feature: string) => features[feature] ?? false))
  vi.stubGlobal('getPlanLimit', vi.fn((_: string, limit: string) => limit === 'forms.models' ? 15 : limit === 'forms.submissions_per_month' ? 3000 : 10))
  vi.stubGlobal('useGitProvider', vi.fn().mockReturnValue({}))
  vi.stubGlobal('normalizeContentRoot', vi.fn().mockReturnValue('.contentrain'))
  vi.stubGlobal('getOrBuildBrainCache', vi.fn().mockResolvedValue({
    config: { locales: { default: options.defaultLocale ?? 'tr', supported: ['tr', 'en'] } },
    models: new Map([['contact', {
      id: 'contact',
      name: 'Contact',
      kind: 'collection',
      fields: {
        name: { type: 'string', required: true },
        email: { type: 'email', required: true },
        secret: { type: 'string' },
      },
      form,
    }]]),
  }))
  vi.stubGlobal('validateContent', vi.fn().mockReturnValue({ valid: true, errors: [] }))
  vi.stubGlobal('emitWebhookEvent', vi.fn().mockResolvedValue(undefined))
  vi.stubGlobal('recordFormSubmissionUsage', vi.fn().mockResolvedValue(undefined))
  vi.stubGlobal('useRuntimeConfig', () => ({
    public: { siteUrl: 'https://studio.test', turnstileSiteKey: options.siteKey ?? '' },
    turnstile: { secretKey: '' },
    resend: { apiKey: 'test' },
  }))
  vi.stubGlobal('emailTemplate', vi.fn((slug: string, params: Record<string, string>) => ({ subject: `${slug}:${params.modelName}`, body: params.summaryHtml ?? '' })))

  return { form, features }
}

function dbStub(extra: Record<string, unknown> = {}) {
  return {
    getProjectById: vi.fn().mockResolvedValue({ id: PROJECT, workspace_id: WORKSPACE, repo_full_name: 'acme/site', content_root: '.contentrain' }),
    getWorkspaceById: vi.fn().mockResolvedValue({ id: WORKSPACE, name: 'Acme', slug: 'acme', plan: 'pro', github_installation_id: 42, overage_settings: null }),
    ...extra,
  }
}

describe('public form routes', () => {
  it('config exposes the project default locale and the Turnstile site key only when captcha is active', async () => {
    stubFormGlobals({ form: { captcha: 'turnstile' }, siteKey: '0xSITE' })
    vi.stubGlobal('useDatabaseProvider', vi.fn().mockReturnValue(dbStub()))

    await withTestServer({
      routes: [{ path: '/api/forms/v1/project-1/contact/config', handler: await loadConfig() }],
    }, async ({ request }) => {
      const response = await request('/api/forms/v1/project-1/contact/config')
      expect(response.status).toBe(200)
      const body = await response.json() as Record<string, unknown>
      expect(body.locale).toBe('tr')
      expect(body.captcha).toBe('turnstile')
      expect(body.captchaSiteKey).toBe('0xSITE')
      expect(Object.keys(body.fields as object)).toEqual(['name', 'email'])
    })

    stubFormGlobals({ form: { captcha: null }, siteKey: '0xSITE' })
    vi.stubGlobal('useDatabaseProvider', vi.fn().mockReturnValue(dbStub()))
    await withTestServer({
      routes: [{ path: '/api/forms/v1/project-1/contact/config', handler: await loadConfig() }],
    }, async ({ request }) => {
      const body = await (await request('/api/forms/v1/project-1/contact/config')).json() as Record<string, unknown>
      expect(body.captcha).toBeNull()
      expect(body.captchaSiteKey).toBeNull()
    })
  })

  it('submit validates in the project locale, stores it on the row, keeps only exposed fields, and notifies owner + admins', async () => {
    stubFormGlobals()
    const createFormSubmissionIfAllowed = vi.fn().mockResolvedValue({ allowed: true, currentCount: 1, submission: { id: 'sub-1', status: 'pending' } })
    const listWorkspaceNotificationRecipients = vi.fn().mockResolvedValue([{ userId: 'u1', email: 'owner@acme.dev' }, { userId: 'u2', email: 'admin@acme.dev' }])
    const sendEmail = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('useDatabaseProvider', vi.fn().mockReturnValue(dbStub({ createFormSubmissionIfAllowed, listWorkspaceNotificationRecipients })))
    vi.stubGlobal('useEmailProvider', vi.fn().mockReturnValue({ sendEmail }))

    await withTestServer({
      routes: [{ path: '/api/forms/v1/project-1/contact/submit', handler: await loadSubmit() }],
    }, async ({ request }) => {
      const response = await request('/api/forms/v1/project-1/contact/submit', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ data: { name: '<b>Ada</b>', email: 'ada@example.com', secret: 'dropped' } }),
      })
      expect(response.status).toBe(200)
      await expect(response.json()).resolves.toMatchObject({ success: true })

      expect(globalThis.validateContent).toHaveBeenCalledWith({ name: 'Ada', email: 'ada@example.com' }, expect.anything(), 'contact', 'tr')
      expect(createFormSubmissionIfAllowed).toHaveBeenCalledWith(WORKSPACE, 3000, expect.objectContaining({
        model_id: 'contact',
        data: { name: 'Ada', email: 'ada@example.com' },
        locale: 'tr',
      }))

      // Notification is fire-and-forget — give it a tick.
      await new Promise(resolve => setTimeout(resolve, 10))
      expect(listWorkspaceNotificationRecipients).toHaveBeenCalledWith(WORKSPACE)
      expect(sendEmail).toHaveBeenCalledTimes(2)
      expect(sendEmail).toHaveBeenCalledWith(expect.objectContaining({ to: 'owner@acme.dev', subject: 'form-submitted:Contact' }))
      expect(sendEmail.mock.calls[0]![0].html).toContain('Ada')
    })
  })

  it('submit honours the per-form monthly cap and skips notifications when the model turns them off', async () => {
    stubFormGlobals({ form: { limits: { maxPerMonth: 5 }, notifications: false } })
    const createFormSubmissionIfAllowed = vi.fn().mockResolvedValue({ allowed: true, currentCount: 1, submission: { id: 'sub-2', status: 'pending' } })
    const countMonthlySubmissionsForModel = vi.fn().mockResolvedValueOnce(5).mockResolvedValueOnce(2)
    const listWorkspaceNotificationRecipients = vi.fn()
    vi.stubGlobal('useDatabaseProvider', vi.fn().mockReturnValue(dbStub({ createFormSubmissionIfAllowed, countMonthlySubmissionsForModel, listWorkspaceNotificationRecipients })))
    vi.stubGlobal('useEmailProvider', vi.fn().mockReturnValue({ sendEmail: vi.fn() }))

    await withTestServer({
      routes: [{ path: '/api/forms/v1/project-1/contact/submit', handler: await loadSubmit() }],
    }, async ({ request }) => {
      const send = () => request('/api/forms/v1/project-1/contact/submit', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ data: { name: 'Ada', email: 'ada@example.com' } }),
      })
      expect((await send()).status).toBe(429)
      expect(createFormSubmissionIfAllowed).not.toHaveBeenCalled()

      expect((await send()).status).toBe(200)
      expect(createFormSubmissionIfAllowed).toHaveBeenCalledTimes(1)
      await new Promise(resolve => setTimeout(resolve, 10))
      expect(listWorkspaceNotificationRecipients).not.toHaveBeenCalled()
    })
  })
})

describe('public form routes — abuse controls', () => {
  it('captcha fails closed without NUXT_TURNSTILE_SECRET_KEY: no siteverify call, no write', async () => {
    stubFormGlobals({ form: { captcha: 'turnstile' } })
    const realFetch = globalThis.fetch
    const outbound = vi.fn()
    vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).startsWith('https://challenges.cloudflare.com/')) {
        outbound()
        return Promise.resolve(new Response(JSON.stringify({ success: true })))
      }
      return realFetch(input, init)
    })
    const createFormSubmissionIfAllowed = vi.fn()
    vi.stubGlobal('useDatabaseProvider', vi.fn().mockReturnValue(dbStub({ createFormSubmissionIfAllowed })))

    await withTestServer({
      routes: [{ path: '/api/forms/v1/project-1/contact/submit', handler: await loadSubmit() }],
    }, async ({ request }) => {
      const response = await request('/api/forms/v1/project-1/contact/submit', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ data: { name: 'Ada', email: 'ada@example.com' }, captchaToken: 'a-token' }),
      })
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ success: false, errors: [{ field: 'captcha', message: 'forms.captcha_failed' }] })
      expect(outbound).not.toHaveBeenCalled()
      expect(createFormSubmissionIfAllowed).not.toHaveBeenCalled()
    })
  })

  it('a filled honeypot is a silent 200 that never reaches the database or the notifier', async () => {
    stubFormGlobals()
    const createFormSubmissionIfAllowed = vi.fn()
    const listWorkspaceNotificationRecipients = vi.fn()
    vi.stubGlobal('useDatabaseProvider', vi.fn().mockReturnValue(dbStub({ createFormSubmissionIfAllowed, listWorkspaceNotificationRecipients })))

    await withTestServer({
      routes: [{ path: '/api/forms/v1/project-1/contact/submit', handler: await loadSubmit() }],
    }, async ({ request }) => {
      const response = await request('/api/forms/v1/project-1/contact/submit', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ data: { name: 'Bot', email: 'bot@example.com' }, _hp: 'http://spam.example' }),
      })
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ success: true, message: 'forms.default_success' })
      await new Promise(resolve => setTimeout(resolve, 10))
      expect(createFormSubmissionIfAllowed).not.toHaveBeenCalled()
      expect(listWorkspaceNotificationRecipients).not.toHaveBeenCalled()
    })
  })

  it('a stray Authorization header is ignored — the surface is public and never reads credentials', async () => {
    stubFormGlobals()
    const createFormSubmissionIfAllowed = vi.fn().mockResolvedValue({ allowed: true, currentCount: 1, submission: { id: 'sub-3', status: 'pending' } })
    vi.stubGlobal('useDatabaseProvider', vi.fn().mockReturnValue(dbStub({ createFormSubmissionIfAllowed })))
    vi.stubGlobal('useEmailProvider', vi.fn().mockReturnValue(null))

    await withTestServer({
      routes: [{ path: '/api/forms/v1/project-1/contact/submit', handler: await loadSubmit() }],
    }, async ({ request }) => {
      const response = await request('/api/forms/v1/project-1/contact/submit', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'authorization': 'Bearer cr_should_never_be_here' },
        body: JSON.stringify({ data: { name: 'Ada', email: 'ada@example.com' } }),
      })
      expect(response.status).toBe(200)
      expect(createFormSubmissionIfAllowed).toHaveBeenCalledTimes(1)
    })
  })
})

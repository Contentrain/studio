/**
 * Contract between a delivered site and Studio's public forms API: the browser client every migrated
 * site ships (`tests/fixtures/starter/embed.ts`, copied from the starter) run against the real `config`
 * and `submit` route handlers. Only the database, Git and Turnstile's siteverify are mocked.
 *
 * What a visitor's form does is the whole chain, so the test walks it: config → the controls the client
 * renders (field names, honeypot, Turnstile widget) → the form data a browser would collect from them →
 * the request body → Studio's answer → what the client shows for it.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { validateContent } from '../../server/utils/content-validation'
import {
  CAPTCHA_FIELD,
  EmbedError,
  errorsHtml,
  fetchFormConfig,
  formHtml,
  formPayload,
  isPaymentRequired,
  submitForm,
} from '../fixtures/starter/embed'
import { withTestServer } from '../helpers/http'

const billingLock = vi.hoisted(() => ({ locked: false }))
vi.mock('../../server/utils/workspace-billing', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../server/utils/workspace-billing')>()
  return {
    ...actual,
    resolveWorkspaceBilling: async (...args: Parameters<typeof actual.resolveWorkspaceBilling>) => {
      if (billingLock.locked && args[2]?.requireAccess) throw Object.assign(new Error('billing.payment_required'), { statusCode: 402, data: { code: 'payment_required', requiresCheckout: true } })
      return actual.resolveWorkspaceBilling(...args)
    },
  }
})

const PROJECT = 'project-1'
const WORKSPACE = 'workspace-1'
const SITE_KEY = '0xSITE'

const dictionary = JSON.parse(readFileSync(new URL('../../.contentrain/content/system/error-messages/en.json', import.meta.url), 'utf8')) as Record<string, string>
const realErrorMessage = (key: string) => dictionary[key] ?? key

const contactModel = {
  id: 'contact',
  name: 'Contact',
  kind: 'collection',
  fields: {
    name: { type: 'string', label: 'Name', required: true },
    email: { type: 'email', label: 'Email', required: true },
    message: { type: 'text', label: 'Message', required: false },
    internal_note: { type: 'string', label: 'Internal note' },
  },
  form: {
    enabled: true,
    public: true,
    exposedFields: ['name', 'email', 'message'],
    honeypot: true,
    captcha: 'turnstile',
    successMessage: 'Thanks! We will get back to you.',
  },
}

function stubStudio() {
  vi.stubGlobal('getRouterParam', vi.fn((_: unknown, key: string) => key === 'projectId' ? PROJECT : key === 'modelId' ? 'contact' : undefined))
  vi.stubGlobal('errorMessage', realErrorMessage)
  vi.stubGlobal('getWorkspacePlan', vi.fn().mockReturnValue('pro'))
  vi.stubGlobal('hasFeature', vi.fn().mockReturnValue(true))
  vi.stubGlobal('getPlanLimit', vi.fn().mockReturnValue(Number.MAX_SAFE_INTEGER))
  vi.stubGlobal('useGitProvider', vi.fn().mockReturnValue({}))
  vi.stubGlobal('normalizeContentRoot', vi.fn().mockReturnValue('.contentrain'))
  vi.stubGlobal('getOrBuildBrainCache', vi.fn().mockResolvedValue({
    config: { locales: { default: 'en', supported: ['en'] } },
    models: new Map([['contact', contactModel]]),
  }))
  vi.stubGlobal('validateContent', validateContent)
  vi.stubGlobal('emitWebhookEvent', vi.fn().mockResolvedValue(undefined))
  vi.stubGlobal('recordFormSubmissionUsage', vi.fn().mockResolvedValue(undefined))
  vi.stubGlobal('useEmailProvider', vi.fn().mockReturnValue(null))
  vi.stubGlobal('useRuntimeConfig', () => ({
    public: { siteUrl: 'https://studio.test', turnstileSiteKey: SITE_KEY },
    turnstile: { secretKey: 'turnstile-secret' },
  }))
  const createFormSubmissionIfAllowed = vi.fn().mockResolvedValue({ allowed: true, currentCount: 1, submission: { id: 'sub-1', status: 'pending' } })
  vi.stubGlobal('useDatabaseProvider', vi.fn().mockReturnValue({
    getProjectById: vi.fn().mockResolvedValue({ id: PROJECT, workspace_id: WORKSPACE, repo_full_name: 'acme/site', content_root: '.contentrain' }),
    getWorkspaceById: vi.fn().mockResolvedValue({ id: WORKSPACE, name: 'Acme', slug: 'acme', plan: 'pro', github_installation_id: 42, overage_settings: null }),
    createFormSubmissionIfAllowed,
  }))
  return { createFormSubmissionIfAllowed }
}

/** Turnstile's siteverify is the only outbound call; the starter client's own requests reach the test server. */
function stubTurnstile(valid: boolean) {
  const realFetch = globalThis.fetch
  const siteverify = vi.fn(async () => new Response(JSON.stringify({ success: valid }), { headers: { 'content-type': 'application/json' } }))
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) =>
    String(input).startsWith('https://challenges.cloudflare.com/') ? siteverify() : realFetch(input, init))
  return siteverify
}

async function routes() {
  const config = (await import('../../server/api/forms/v1/[projectId]/[modelId]/config.get')).default
  const submit = (await import('../../server/api/forms/v1/[projectId]/[modelId]/submit.post')).default
  return [
    { path: `/api/forms/v1/${PROJECT}/contact/config`, handler: config },
    { path: `/api/forms/v1/${PROJECT}/contact/submit`, handler: submit },
  ]
}

/** The names a browser would collect from the markup the client rendered — what `new FormData(form)` iterates. */
function controlNames(html: string): string[] {
  return [...html.matchAll(/<(?:input|textarea|select)\b[^>]*\bname="([^"]+)"/g)].map(m => m[1]!)
}

/** What the browser holds once the visitor typed: every named control, plus the token Turnstile's widget writes. */
function formData(names: string[], typed: Record<string, string>, token?: string): Array<[string, unknown]> {
  const entries: Array<[string, unknown]> = names.map(name => [name, typed[name] ?? ''])
  if (token !== undefined) entries.push([CAPTCHA_FIELD, token])
  return entries
}

describe('delivered site ↔ Studio forms API', () => {
  it('the form the client renders from Studio\'s config posts a body Studio accepts, and stores only exposed fields', async () => {
    const { createFormSubmissionIfAllowed } = stubStudio()
    const siteverify = stubTurnstile(true)

    await withTestServer({ routes: await routes() }, async ({ baseUrl }) => {
      const rt = { base_url: baseUrl, project_id: PROJECT }
      const config = await fetchFormConfig(rt, 'contact')
      expect(config.captcha).toBe('turnstile')
      expect(config.captchaSiteKey).toBe(SITE_KEY)
      expect(config.honeypotField).toBe('_hp')

      const html = formHtml(config)
      expect(html).toContain(`data-sitekey="${SITE_KEY}"`)
      const names = controlNames(html)
      expect(names).toEqual(['name', 'email', 'message', '_hp'])
      expect(names).not.toContain('internal_note')

      const payload = formPayload(formData(names, { name: 'Ada', email: 'ada@example.com', message: 'Hello' }, 'turnstile-token'), config)
      expect(payload).toEqual({ data: { name: 'Ada', email: 'ada@example.com', message: 'Hello' }, captchaToken: 'turnstile-token', _hp: '' })

      const result = await submitForm(rt, 'contact', payload)
      expect(result).toEqual({ success: true, message: 'Thanks! We will get back to you.' })
      expect(siteverify).toHaveBeenCalledTimes(1)
      expect(createFormSubmissionIfAllowed).toHaveBeenCalledWith(WORKSPACE, expect.anything(), expect.objectContaining({
        model_id: 'contact',
        data: { name: 'Ada', email: 'ada@example.com', message: 'Hello' },
      }))
    })
  })

  it('a filled honeypot reads as success to the client and writes nothing', async () => {
    const { createFormSubmissionIfAllowed } = stubStudio()
    stubTurnstile(true)

    await withTestServer({ routes: await routes() }, async ({ baseUrl }) => {
      const rt = { base_url: baseUrl, project_id: PROJECT }
      const config = await fetchFormConfig(rt, 'contact')
      const names = controlNames(formHtml(config))
      const payload = formPayload(formData(names, { name: 'Bot', email: 'bot@example.com', _hp: 'spam' }, 'turnstile-token'), config)
      expect(payload._hp).toBe('spam')

      expect(await submitForm(rt, 'contact', payload)).toMatchObject({ success: true })
      expect(createFormSubmissionIfAllowed).not.toHaveBeenCalled()
    })
  })

  it('no Turnstile token, or a rejected one, comes back as a captcha error the client lists', async () => {
    const { createFormSubmissionIfAllowed } = stubStudio()
    const siteverify = stubTurnstile(false)

    await withTestServer({ routes: await routes() }, async ({ baseUrl }) => {
      const rt = { base_url: baseUrl, project_id: PROJECT }
      const config = await fetchFormConfig(rt, 'contact')
      const names = controlNames(formHtml(config))
      const typed = { name: 'Ada', email: 'ada@example.com' }

      // The widget has not produced a token yet: the client sends none (an empty value is dropped, not posted).
      const missing = formPayload(formData(names, typed, ''), config)
      expect(missing.captchaToken).toBeUndefined()
      const noToken = await submitForm(rt, 'contact', missing)
      expect(noToken.success).toBe(false)
      expect(noToken.errors).toEqual([{ field: 'captcha', message: dictionary['forms.captcha_failed'] }])
      expect(siteverify).not.toHaveBeenCalled()

      const rejected = await submitForm(rt, 'contact', formPayload(formData(names, typed, 'stale-token'), config))
      expect(rejected.success).toBe(false)
      expect(rejected.errors?.[0]?.field).toBe('captcha')
      expect(siteverify).toHaveBeenCalledTimes(1)
      expect(errorsHtml(rejected.errors ?? [])).toContain('data-field="captcha"')
      expect(createFormSubmissionIfAllowed).not.toHaveBeenCalled()
    })
  })

  it('a required field left empty is answered as `success: false` with `{ field, message }` entries', async () => {
    const { createFormSubmissionIfAllowed } = stubStudio()
    stubTurnstile(true)

    await withTestServer({ routes: await routes() }, async ({ baseUrl }) => {
      const rt = { base_url: baseUrl, project_id: PROJECT }
      const config = await fetchFormConfig(rt, 'contact')
      const names = controlNames(formHtml(config))
      const result = await submitForm(rt, 'contact', formPayload(formData(names, { email: 'not-an-email' }, 'turnstile-token'), config))

      expect(result.success).toBe(false)
      expect(result.errors?.map(e => e.field)).toContain('name')
      expect(typeof result.errors?.[0]?.message).toBe('string')
      expect(createFormSubmissionIfAllowed).not.toHaveBeenCalled()
    })
  })

  it('a locked workspace answers 402 on config and submit, which the client hides the widget for', async () => {
    stubStudio()
    stubTurnstile(true)
    billingLock.locked = true
    try {
      await withTestServer({ routes: await routes() }, async ({ baseUrl }) => {
        const rt = { base_url: baseUrl, project_id: PROJECT }
        const onConfig = await fetchFormConfig(rt, 'contact').catch((e: unknown) => e)
        expect(onConfig).toBeInstanceOf(EmbedError)
        expect(isPaymentRequired(onConfig)).toBe(true)

        const onSubmit = await submitForm(rt, 'contact', { data: { name: 'Ada', email: 'ada@example.com' } }).catch((e: unknown) => e)
        expect(isPaymentRequired(onSubmit)).toBe(true)
      })
    }
    finally {
      billingLock.locked = false
    }
  })
})

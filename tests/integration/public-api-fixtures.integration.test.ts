/**
 * Wire-contract conformance for the public surfaces (forms + comments):
 * the real route handlers, the real CORS middleware, the real dictionary
 * messages and the real content validator, against the fixtures in
 * `tests/fixtures/public-api/`. Only the database, Git and Turnstile are
 * mocked. A response that drifts from its fixture fails here — the fixture
 * files are what external clients (the `@contentrain/sdk` forms/comments
 * clients, generated Astro components) build against.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { validateContent } from '../../server/utils/content-validation'
import { withTestServer } from '../helpers/http'

const FIXTURES = new URL('../fixtures/public-api/', import.meta.url)
function fixture<T = Record<string, unknown>>(name: string): T {
  return JSON.parse(readFileSync(new URL(name, FIXTURES), 'utf8')) as T
}

// The real `error-messages` dictionary, so fixtures carry the strings a
// visitor sees rather than keys. Same interpolation as content-strings.ts.
const dictionary = JSON.parse(readFileSync(new URL('../../.contentrain/content/system/error-messages/en.json', import.meta.url), 'utf8')) as Record<string, string>
function realErrorMessage(key: string, params?: Record<string, string | number>) {
  let value = dictionary[key] ?? key
  for (const [k, v] of Object.entries(params ?? {})) value = value.replaceAll(`{${k}}`, String(v))
  return value
}

const PROJECT = '4f3f5b4e-1c2d-4a5b-9c6d-7e8f9a0b1c2d'
const WORKSPACE = 'workspace-1'
const SITE_KEY = '0x4AAAAAAA-fixture-site-key'

const JSON_HEADERS = { 'content-type': 'application/json', 'origin': 'https://site.example' }

async function loadFormConfig() {
  return (await import('../../server/api/forms/v1/[projectId]/[modelId]/config.get')).default
}
async function loadFormSubmit() {
  return (await import('../../server/api/forms/v1/[projectId]/[modelId]/submit.post')).default
}
async function loadCommentsGet() {
  return (await import('../../server/api/comments/v1/[projectId]/[modelId]/[entryId].get')).default
}
async function loadCommentsPost() {
  return (await import('../../server/api/comments/v1/[projectId]/[modelId]/[entryId].post')).default
}
async function loadCors() {
  return (await import('../../server/middleware/00.public-cors')).default
}

/** Turnstile siteverify is the only outbound call; answer it in-process and let everything else hit the test server. */
function stubTurnstile(valid: boolean) {
  const realFetch = globalThis.fetch
  const siteverify = vi.fn(async () => new Response(JSON.stringify({ success: valid }), { headers: { 'content-type': 'application/json' } }))
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
    return String(input).startsWith('https://challenges.cloudflare.com/') ? siteverify() : realFetch(input, init)
  })
  return siteverify
}

function stubCommon(options: { model: Record<string, unknown>, modelId: string, entryId?: string, locale?: string }) {
  vi.stubGlobal('getRouterParam', vi.fn((_: unknown, key: string) => {
    if (key === 'projectId') return PROJECT
    if (key === 'modelId') return options.modelId
    if (key === 'entryId') return options.entryId
    return undefined
  }))
  vi.stubGlobal('errorMessage', realErrorMessage)
  vi.stubGlobal('getWorkspacePlan', vi.fn().mockReturnValue('pro'))
  vi.stubGlobal('hasFeature', vi.fn().mockReturnValue(true))
  vi.stubGlobal('getPlanLimit', vi.fn().mockReturnValue(Number.MAX_SAFE_INTEGER))
  vi.stubGlobal('useGitProvider', vi.fn().mockReturnValue({}))
  vi.stubGlobal('normalizeContentRoot', vi.fn().mockReturnValue('.contentrain'))
  vi.stubGlobal('getOrBuildBrainCache', vi.fn().mockResolvedValue({
    config: { locales: { default: options.locale ?? 'en', supported: [options.locale ?? 'en'] } },
    models: new Map([[options.modelId, options.model]]),
  }))
  vi.stubGlobal('validateContent', validateContent)
  vi.stubGlobal('emitWebhookEvent', vi.fn().mockResolvedValue(undefined))
  vi.stubGlobal('recordFormSubmissionUsage', vi.fn().mockResolvedValue(undefined))
  vi.stubGlobal('useEmailProvider', vi.fn().mockReturnValue(null))
  vi.stubGlobal('useRuntimeConfig', () => ({
    public: { siteUrl: 'https://studio.test', turnstileSiteKey: SITE_KEY },
    turnstile: { secretKey: 'turnstile-secret' },
  }))
}

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

const postsModel = {
  id: 'posts',
  kind: 'collection',
  comments: { enabled: true, requireApproval: true, requireEmail: true, honeypot: true, captcha: 'turnstile' },
}

function db(extra: Record<string, unknown> = {}) {
  return {
    getProjectById: vi.fn().mockResolvedValue({ id: PROJECT, workspace_id: WORKSPACE, repo_full_name: 'acme/site', content_root: '.contentrain' }),
    getWorkspaceById: vi.fn().mockResolvedValue({ id: WORKSPACE, name: 'Acme', slug: 'acme', plan: 'pro', github_installation_id: 42, overage_settings: null }),
    ...extra,
  }
}

const commentRow = (over: Record<string, unknown>) => ({
  project_id: PROJECT,
  workspace_id: WORKSPACE,
  model_id: 'posts',
  entry_id: 'hello-world',
  locale: 'en',
  parent_id: null,
  depth: 0,
  author_email: 'ada@example.com',
  author_url: null,
  author_user_id: null,
  type: 'comment',
  status: 'approved',
  source: 'web',
  source_ip: '203.0.113.9',
  user_agent: 'Mozilla/5.0 fixture',
  referrer: 'https://site.example/hello-world',
  ...over,
})

describe('public API fixtures — forms', () => {
  it('GET config matches forms.config.response.json and carries CORS headers', async () => {
    stubCommon({ model: contactModel, modelId: 'contact' })
    vi.stubGlobal('useDatabaseProvider', vi.fn().mockReturnValue(db()))

    await withTestServer({
      middleware: [await loadCors()],
      routes: [{ path: `/api/forms/v1/${PROJECT}/contact/config`, handler: await loadFormConfig() }],
    }, async ({ request }) => {
      const response = await request(`/api/forms/v1/${PROJECT}/contact/config`, { headers: { origin: 'https://site.example' } })
      expect(response.status).toBe(200)
      expect(response.headers.get('access-control-allow-origin')).toBe('*')
      expect(await response.json()).toEqual(fixture('forms.config.response.json'))
    })
  })

  it('POST submit: request fixture → success fixture; only exposed fields reach the database', async () => {
    stubCommon({ model: contactModel, modelId: 'contact' })
    const siteverify = stubTurnstile(true)
    const createFormSubmissionIfAllowed = vi.fn().mockResolvedValue({ allowed: true, currentCount: 1, submission: { id: 'sub-1', status: 'pending' } })
    vi.stubGlobal('useDatabaseProvider', vi.fn().mockReturnValue(db({ createFormSubmissionIfAllowed })))

    await withTestServer({
      middleware: [await loadCors()],
      routes: [{ path: `/api/forms/v1/${PROJECT}/contact/submit`, handler: await loadFormSubmit() }],
    }, async ({ request }) => {
      const body = fixture('forms.submit.request.json')
      const response = await request(`/api/forms/v1/${PROJECT}/contact/submit`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ ...body, data: { ...(body.data as object), internal_note: 'must be dropped' } }),
      })
      expect(response.status).toBe(200)
      expect(response.headers.get('access-control-allow-origin')).toBe('*')
      expect(await response.json()).toEqual(fixture('forms.submit.success.response.json'))

      expect(siteverify).toHaveBeenCalledTimes(1)
      expect(createFormSubmissionIfAllowed).toHaveBeenCalledWith(WORKSPACE, Number.MAX_SAFE_INTEGER, expect.objectContaining({
        project_id: PROJECT,
        model_id: 'contact',
        locale: 'en',
        data: body.data,
      }))
    })
  })

  it('POST submit: invalid request fixture → validation-error fixture (real validator, nothing stored)', async () => {
    stubCommon({ model: contactModel, modelId: 'contact' })
    stubTurnstile(true)
    const createFormSubmissionIfAllowed = vi.fn()
    vi.stubGlobal('useDatabaseProvider', vi.fn().mockReturnValue(db({ createFormSubmissionIfAllowed })))

    await withTestServer({
      routes: [{ path: `/api/forms/v1/${PROJECT}/contact/submit`, handler: await loadFormSubmit() }],
    }, async ({ request }) => {
      const response = await request(`/api/forms/v1/${PROJECT}/contact/submit`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify(fixture('forms.submit.invalid.request.json')),
      })
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual(fixture('forms.submit.validation-error.response.json'))
      expect(createFormSubmissionIfAllowed).not.toHaveBeenCalled()
    })
  })

  it('POST submit: a missing or rejected Turnstile token → captcha-error fixture', async () => {
    stubCommon({ model: contactModel, modelId: 'contact' })
    const siteverify = stubTurnstile(false)
    const createFormSubmissionIfAllowed = vi.fn()
    vi.stubGlobal('useDatabaseProvider', vi.fn().mockReturnValue(db({ createFormSubmissionIfAllowed })))

    await withTestServer({
      routes: [{ path: `/api/forms/v1/${PROJECT}/contact/submit`, handler: await loadFormSubmit() }],
    }, async ({ request }) => {
      const { captchaToken: _omit, ...withoutToken } = fixture('forms.submit.request.json')
      const missing = await request(`/api/forms/v1/${PROJECT}/contact/submit`, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(withoutToken) })
      expect(missing.status).toBe(200)
      expect(await missing.json()).toEqual(fixture('forms.submit.captcha-error.response.json'))
      expect(siteverify).not.toHaveBeenCalled()

      const rejected = await request(`/api/forms/v1/${PROJECT}/contact/submit`, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(fixture('forms.submit.request.json')) })
      expect(await rejected.json()).toEqual(fixture('forms.submit.captcha-error.response.json'))
      expect(siteverify).toHaveBeenCalledTimes(1)
      expect(createFormSubmissionIfAllowed).not.toHaveBeenCalled()
    })
  })

  it('POST submit: the legacy flat SDK body is a 400 and cf-turnstile-response is never read', async () => {
    stubCommon({ model: contactModel, modelId: 'contact' })
    const siteverify = stubTurnstile(true)
    const createFormSubmissionIfAllowed = vi.fn()
    vi.stubGlobal('useDatabaseProvider', vi.fn().mockReturnValue(db({ createFormSubmissionIfAllowed })))

    await withTestServer({
      routes: [{ path: `/api/forms/v1/${PROJECT}/contact/submit`, handler: await loadFormSubmit() }],
    }, async ({ request }) => {
      const response = await request(`/api/forms/v1/${PROJECT}/contact/submit`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify(fixture('forms.submit.legacy-flat.request.json')),
      })
      expect(response.status).toBe(400)
      expect(siteverify).not.toHaveBeenCalled()
      expect(createFormSubmissionIfAllowed).not.toHaveBeenCalled()

      // `data` must be an object, not an array.
      const asArray = await request(`/api/forms/v1/${PROJECT}/contact/submit`, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ data: [['name', 'Ada']] }) })
      expect(asArray.status).toBe(400)
    })
  })
})

describe('public API fixtures — comments', () => {
  it('GET matches comments.read.response.json and leaks no private column', async () => {
    stubCommon({ model: postsModel, modelId: 'posts', entryId: 'hello-world' })
    const expected = fixture<{ comments: Array<{ id: string, replies: Array<{ id: string }> }> }>('comments.read.response.json')
    const root = expected.comments[0]!
    vi.stubGlobal('useDatabaseProvider', vi.fn().mockReturnValue(db({
      getCommentThread: vi.fn().mockResolvedValue(null),
      listPublicComments: vi.fn().mockResolvedValue({
        total: 1,
        roots: [commentRow({ id: root.id, author_name: 'Ada', author_url: 'https://ada.dev/', body: 'First!', created_at: '2026-09-01T10:00:00.000Z' })],
        replies: [commentRow({ id: root.replies[0]!.id, parent_id: root.id, depth: 1, author_name: 'Site editor', author_email: null, author_user_id: 'user-1', source: 'studio', body: 'Welcome aboard.', created_at: '2026-09-01T11:00:00.000Z' })],
      }),
    })))

    await withTestServer({
      middleware: [await loadCors()],
      routes: [{ path: `/api/comments/v1/${PROJECT}/posts/hello-world`, handler: await loadCommentsGet() }],
    }, async ({ request }) => {
      const response = await request(`/api/comments/v1/${PROJECT}/posts/hello-world?locale=en`, { headers: { origin: 'https://site.example' } })
      expect(response.status).toBe(200)
      expect(response.headers.get('access-control-allow-origin')).toBe('*')
      const text = await response.text()
      expect(JSON.parse(text)).toEqual(expected)
      for (const secret of ['ada@example.com', '203.0.113.9', 'Mozilla/5.0 fixture', 'site.example/hello-world', 'user-1'])
        expect(text).not.toContain(secret)
    })
  })

  it('POST: request fixture → pending fixture (requireApproval) and approved fixture (auto-approve)', async () => {
    const run = async (requireApproval: boolean, expectedFixture: string) => {
      stubCommon({ model: { ...postsModel, comments: { ...postsModel.comments, requireApproval } }, modelId: 'posts', entryId: 'hello-world' })
      const siteverify = stubTurnstile(true)
      const expected = fixture<{ comment: { id: string, createdAt: string }, status: string }>(expectedFixture)
      const createCommentIfAllowed = vi.fn().mockImplementation(async (_ws: string, _limit: number, input: Record<string, unknown>) => ({
        allowed: true,
        currentCount: 1,
        comment: commentRow({ id: expected.comment.id, author_name: input.author_name, author_email: input.author_email, author_url: input.author_url, body: input.body, status: input.status, created_at: expected.comment.createdAt }),
      }))
      vi.stubGlobal('useDatabaseProvider', vi.fn().mockReturnValue(db({ createCommentIfAllowed })))

      await withTestServer({
        middleware: [await loadCors()],
        routes: [{ path: `/api/comments/v1/${PROJECT}/posts/hello-world`, handler: await loadCommentsPost() }],
      }, async ({ request }) => {
        const response = await request(`/api/comments/v1/${PROJECT}/posts/hello-world?locale=en`, {
          method: 'POST',
          headers: JSON_HEADERS,
          body: JSON.stringify(fixture('comments.submit.request.json')),
        })
        expect(response.status).toBe(200)
        expect(response.headers.get('access-control-allow-origin')).toBe('*')
        const text = await response.text()
        expect(JSON.parse(text)).toEqual(expected)
        expect(text).not.toContain('grace@example.com')
        expect(siteverify).toHaveBeenCalledTimes(1)
        expect(createCommentIfAllowed).toHaveBeenCalledWith(WORKSPACE, Number.MAX_SAFE_INTEGER, expect.objectContaining({
          author_name: 'Grace',
          author_email: 'grace@example.com',
          author_url: 'https://grace.dev/',
          body: 'Great post!',
          parent_id: null,
          status: expected.status,
        }))
      })
    }

    await run(true, 'comments.submit.pending.response.json')
    await run(false, 'comments.submit.approved.response.json')
  })

  it('POST: invalid request fixture → validation-error fixture; filled honeypot → honeypot fixture; no writes', async () => {
    stubCommon({ model: postsModel, modelId: 'posts', entryId: 'hello-world' })
    stubTurnstile(true)
    const createCommentIfAllowed = vi.fn()
    vi.stubGlobal('useDatabaseProvider', vi.fn().mockReturnValue(db({ createCommentIfAllowed })))

    await withTestServer({
      routes: [{ path: `/api/comments/v1/${PROJECT}/posts/hello-world`, handler: await loadCommentsPost() }],
    }, async ({ request }) => {
      const invalid = await request(`/api/comments/v1/${PROJECT}/posts/hello-world`, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(fixture('comments.submit.invalid.request.json')) })
      expect(invalid.status).toBe(200)
      expect(await invalid.json()).toEqual(fixture('comments.submit.validation-error.response.json'))

      const bot = await request(`/api/comments/v1/${PROJECT}/posts/hello-world`, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ ...fixture('comments.submit.request.json'), _hp: 'http://spam.example' }) })
      expect(bot.status).toBe(200)
      expect(await bot.json()).toEqual(fixture('comments.submit.honeypot.response.json'))

      expect(createCommentIfAllowed).not.toHaveBeenCalled()
    })
  })
})

describe('public API fixtures — CORS and errors', () => {
  it('OPTIONS preflight on both prefixes matches cors.preflight.response.json; other API paths get no CORS headers', async () => {
    const expected = fixture<{ status: number, headers: Record<string, string> }>('cors.preflight.response.json')
    await withTestServer({
      middleware: [await loadCors()],
      routes: [{ path: '/api/workspaces/w1/projects', handler: defineEventHandler(() => ({ ok: true })) }],
    }, async ({ request }) => {
      for (const path of [`/api/forms/v1/${PROJECT}/contact/submit`, `/api/comments/v1/${PROJECT}/posts/hello-world`]) {
        const response = await request(path, {
          method: 'OPTIONS',
          headers: { 'origin': 'https://site.example', 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' },
        })
        expect(response.status).toBe(expected.status)
        for (const [name, value] of Object.entries(expected.headers))
          expect(response.headers.get(name)).toBe(value)
        // Authorization is deliberately not allowed: a public page must not carry a Studio credential.
        expect(response.headers.get('access-control-allow-headers')).not.toMatch(/authorization/i)
      }

      const internal = await request('/api/workspaces/w1/projects', { headers: { origin: 'https://site.example' } })
      expect(internal.status).toBe(200)
      expect(internal.headers.get('access-control-allow-origin')).toBeNull()
    })
  })

  it('errors.json carries the dictionary strings and the status codes the routes actually emit', async () => {
    const catalogue = fixture<{ forms: Array<{ statusCode: number, key: string, message: string }>, comments: Array<{ statusCode: number, key: string, message: string }> }>('errors.json')
    for (const entry of [...catalogue.forms, ...catalogue.comments])
      expect(entry.message, entry.key).toBe(realErrorMessage(entry.key))

    const expectStatus = (list: Array<{ statusCode: number, key: string }>, key: string) => list.find(e => e.key === key)!.statusCode

    // forms: disabled form → 404, plan → 403, per-IP → 429
    stubCommon({ model: { ...contactModel, form: { ...contactModel.form, public: false } }, modelId: 'contact' })
    vi.stubGlobal('useDatabaseProvider', vi.fn().mockReturnValue(db()))
    await withTestServer({ routes: [{ path: `/api/forms/v1/${PROJECT}/contact/config`, handler: await loadFormConfig() }] }, async ({ request }) => {
      expect((await request(`/api/forms/v1/${PROJECT}/contact/config`)).status).toBe(expectStatus(catalogue.forms, 'forms.form_disabled'))
    })

    stubCommon({ model: contactModel, modelId: 'contact' })
    vi.stubGlobal('hasFeature', vi.fn((_: string, feature: string) => feature !== 'forms.enabled'))
    vi.stubGlobal('useDatabaseProvider', vi.fn().mockReturnValue(db()))
    await withTestServer({ routes: [{ path: `/api/forms/v1/${PROJECT}/contact/submit`, handler: await loadFormSubmit() }] }, async ({ request }) => {
      const response = await request(`/api/forms/v1/${PROJECT}/contact/submit`, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(fixture('forms.submit.request.json')) })
      expect(response.status).toBe(expectStatus(catalogue.forms, 'forms.upgrade'))
    })

    stubCommon({ model: contactModel, modelId: 'contact' })
    vi.stubGlobal('checkRateLimit', vi.fn().mockResolvedValue({ allowed: false, retryAfterMs: 1000 }))
    vi.stubGlobal('useDatabaseProvider', vi.fn().mockReturnValue(db()))
    await withTestServer({ routes: [{ path: `/api/forms/v1/${PROJECT}/contact/submit`, handler: await loadFormSubmit() }] }, async ({ request }) => {
      const response = await request(`/api/forms/v1/${PROJECT}/contact/submit`, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(fixture('forms.submit.request.json')) })
      expect(response.status).toBe(expectStatus(catalogue.forms, 'forms.rate_limited'))
    })

    // comments: closed thread → 403 on submit while read still serves the thread with config.closed
    stubCommon({ model: postsModel, modelId: 'posts', entryId: 'hello-world' })
    vi.stubGlobal('checkRateLimit', vi.fn().mockResolvedValue({ allowed: true, retryAfterMs: 0 }))
    stubTurnstile(true)
    vi.stubGlobal('useDatabaseProvider', vi.fn().mockReturnValue(db({
      getCommentThread: vi.fn().mockResolvedValue({ closed_at: '2026-09-01T00:00:00.000Z' }),
      listPublicComments: vi.fn().mockResolvedValue({ roots: [], replies: [], total: 0 }),
      createCommentIfAllowed: vi.fn().mockResolvedValue({ allowed: false, reason: 'thread_closed' }),
    })))
    await withTestServer({
      routes: [{ path: `/api/comments/v1/${PROJECT}/posts/hello-world`, handler: defineEventHandler(async event => event.method === 'GET' ? (await loadCommentsGet())(event) : (await loadCommentsPost())(event)) }],
    }, async ({ request }) => {
      const read = await request(`/api/comments/v1/${PROJECT}/posts/hello-world`)
      expect(read.status).toBe(200)
      expect(await read.json()).toMatchObject({ config: { closed: true }, comments: [], total: 0 })

      const write = await request(`/api/comments/v1/${PROJECT}/posts/hello-world`, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(fixture('comments.submit.request.json')) })
      expect(write.status).toBe(expectStatus(catalogue.comments, 'comments.thread_closed'))
    })

    // comments: unknown project → 404 on both
    stubCommon({ model: postsModel, modelId: 'posts', entryId: 'hello-world' })
    vi.stubGlobal('useDatabaseProvider', vi.fn().mockReturnValue(db({ getProjectById: vi.fn().mockResolvedValue(null) })))
    await withTestServer({ routes: [{ path: `/api/comments/v1/${PROJECT}/posts/hello-world`, handler: await loadCommentsGet() }] }, async ({ request }) => {
      expect((await request(`/api/comments/v1/${PROJECT}/posts/hello-world`)).status).toBe(expectStatus(catalogue.comments, 'comments.not_found'))
    })
  })
})

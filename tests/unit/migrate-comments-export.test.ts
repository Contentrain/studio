import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MigrateStudioCommentsExport } from '@contentrain/types'
import {
  captureClaimCommentsExport,
  CommentsExportFetchError,
  fetchClaimCommentsExport,
  isAllowedExportUrl,
  migrateExportOrigins,
} from '../../server/utils/migrate-comments-export'

const TOKEN = 'eyJhbGciOiJFZERTQSJ9.secret-bearer.sig'
const ORIGINS = ['https://migrate.example']

const pointer: MigrateStudioCommentsExport = {
  url: 'https://migrate.example/api/exports/comments',
  token: TOKEN,
  expires_at: 1_900_000_000,
  comments: 2,
}

const exportPayload = {
  version: 1,
  format: 'contentrain-comments@1',
  source: { kind: 'wxr' },
  generated_at: '2026-09-27T10:00:00.000Z',
  entries: { 10: { model_id: 'posts', entry_id: 'entry-1' } },
  threads_closed: [],
  comments: [
    { id: 1, post: 10, parent: null, author: 'Ada', date: '2020-05-01T10:00:00Z', content: 'Hi', approved: '1' },
    { id: 2, post: 10, parent: 1, author: 'Bob', date: '2020-05-02T10:00:00Z', content: 'Yo', approved: '1' },
  ],
}

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), { status: 200, ...init })
}

const fast = { origins: ORIGINS, retryDelayMs: 0 }

describe('migrateExportOrigins', () => {
  it('keeps https origins and localhost http, drops everything else', () => {
    expect(migrateExportOrigins('https://migrate.example/, http://localhost:3000 ,http://evil.example, ftp://x, not a url,')).toEqual([
      'https://migrate.example',
      'http://localhost:3000',
    ])
  })

  it('is empty by default: nothing is fetched', () => {
    vi.stubGlobal('useRuntimeConfig', () => ({ migrate: {} }))
    expect(migrateExportOrigins()).toEqual([])
    vi.unstubAllGlobals()
  })
})

describe('isAllowedExportUrl', () => {
  it('takes only Migrate\'s export path on an allowed origin', () => {
    expect(isAllowedExportUrl('https://migrate.example/api/exports/comments', ORIGINS)).toBe(true)
    expect(isAllowedExportUrl('https://other.example/api/exports/comments', ORIGINS)).toBe(false)
    expect(isAllowedExportUrl('https://migrate.example/api/exports/other', ORIGINS)).toBe(false)
    expect(isAllowedExportUrl('https://migrate.example:8443/api/exports/comments', ORIGINS)).toBe(false)
    expect(isAllowedExportUrl('http://migrate.example/api/exports/comments', ORIGINS)).toBe(false)
  })

  it('refuses userinfo, a query or a fragment, and anything that is not a URL', () => {
    expect(isAllowedExportUrl('https://user:pw@migrate.example/api/exports/comments', ORIGINS)).toBe(false)
    expect(isAllowedExportUrl('https://migrate.example/api/exports/comments?x=1', ORIGINS)).toBe(false)
    expect(isAllowedExportUrl('https://migrate.example/api/exports/comments#x', ORIGINS)).toBe(false)
    expect(isAllowedExportUrl('/api/exports/comments', ORIGINS)).toBe(false)
  })
})

describe('fetchClaimCommentsExport', () => {
  it('sends the token as a bearer, never follows a redirect, and returns the checked export', async () => {
    const fetchImpl = vi.fn(async () => json(exportPayload))
    const result = await fetchClaimCommentsExport(pointer, { ...fast, fetchImpl })
    expect(result).toEqual({ payload: exportPayload, comments: 2 })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(pointer.url)
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`)
    expect(init.redirect).toBe('manual')
    expect(init.signal).toBeInstanceOf(AbortSignal)
  })

  it('does not fetch an address off the allowlist', async () => {
    const fetchImpl = vi.fn()
    await expect(fetchClaimCommentsExport({ ...pointer, url: 'https://attacker.example/api/exports/comments' }, { ...fast, fetchImpl }))
      .rejects.toMatchObject({ code: 'not_allowed' })
    await expect(fetchClaimCommentsExport(pointer, { origins: [], fetchImpl })).rejects.toMatchObject({ code: 'not_allowed' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it.each([401, 403, 404, 502])('retries once after a %i, then succeeds', async (status) => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response('no', { status }))
      .mockResolvedValueOnce(json(exportPayload))
    await expect(fetchClaimCommentsExport(pointer, { ...fast, fetchImpl })).resolves.toMatchObject({ comments: 2 })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('gives up after the second refusal', async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 404 }))
    await expect(fetchClaimCommentsExport(pointer, { ...fast, fetchImpl })).rejects.toMatchObject({ code: 'refused', status: 404 })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('treats a redirect as a bad status, without following it or retrying', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 302, headers: { location: 'https://attacker.example/' } }))
    await expect(fetchClaimCommentsExport(pointer, { ...fast, fetchImpl })).rejects.toMatchObject({ code: 'bad_status', status: 302 })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('retries a timed-out attempt once', async () => {
    const fetchImpl = vi.fn((_: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal!.addEventListener('abort', () => reject(init.signal!.reason))
    }))
    await expect(fetchClaimCommentsExport(pointer, { ...fast, fetchImpl: fetchImpl as unknown as typeof fetch, attemptMs: 5 }))
      .rejects.toMatchObject({ code: 'timeout' })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('stops reading at the size cap and does not retry', async () => {
    const big = JSON.stringify({ ...exportPayload, pad: 'x'.repeat(2048) })
    const streamed = vi.fn(async () => new Response(new Blob([big]).stream(), { status: 200 }))
    await expect(fetchClaimCommentsExport(pointer, { ...fast, fetchImpl: streamed, maxBytes: 1024 })).rejects.toMatchObject({ code: 'too_large' })
    expect(streamed).toHaveBeenCalledTimes(1)

    const declared = vi.fn(async () => new Response(big, { status: 200, headers: { 'content-length': String(big.length) } }))
    await expect(fetchClaimCommentsExport(pointer, { ...fast, fetchImpl: declared, maxBytes: 1024 })).rejects.toMatchObject({ code: 'too_large' })
  })

  it('refuses a body that is not a contentrain-comments@1 export', async () => {
    const notJson = vi.fn(async () => new Response('<html>', { status: 200 }))
    await expect(fetchClaimCommentsExport(pointer, { ...fast, fetchImpl: notJson })).rejects.toMatchObject({ code: 'invalid' })
    const wrongShape = vi.fn(async () => json({ format: 'something-else', comments: [] }))
    await expect(fetchClaimCommentsExport(pointer, { ...fast, fetchImpl: wrongShape })).rejects.toMatchObject({ code: 'invalid' })
    expect(notJson).toHaveBeenCalledTimes(1)
  })

  it('never puts the token in an error', async () => {
    const fetchImpl = vi.fn(async () => Promise.reject(new TypeError(`fetch failed for ${TOKEN}`)))
    const error = await fetchClaimCommentsExport(pointer, { ...fast, fetchImpl }).catch(e => e as CommentsExportFetchError)
    expect(error).toBeInstanceOf(CommentsExportFetchError)
    expect(error.code).toBe('network')
    expect(String(error.message)).not.toContain(TOKEN)
    expect(JSON.stringify(error)).not.toContain(TOKEN)
  })
})

describe('captureClaimCommentsExport', () => {
  let db: Record<string, ReturnType<typeof vi.fn>>
  let warn: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    db = {
      getMigrateCommentsExportState: vi.fn().mockResolvedValue(null),
      saveMigrateCommentsExport: vi.fn().mockResolvedValue(undefined),
    }
    vi.stubGlobal('useDatabaseProvider', () => db)
    vi.stubGlobal('useRuntimeConfig', () => ({ migrate: { origins: '' } }))
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    warn.mockRestore()
    vi.unstubAllGlobals()
  })

  it('holds a fetched export on the grant as ready, with the claim\'s expiry and without the token', async () => {
    const fetchImpl = vi.fn(async () => json(exportPayload))
    await expect(captureClaimCommentsExport({ grantId: 'g-1', pointer }, { ...fast, fetchImpl })).resolves.toBe('ready')
    expect(db.saveMigrateCommentsExport).toHaveBeenCalledWith('g-1', {
      status: 'ready',
      payload: exportPayload,
      comments: 2,
      expiresAt: expect.any(String),
    })
    // The window is the grant's 30 days from the fetch, not the URL's own expiry.
    const saved = db.saveMigrateCommentsExport!.mock.calls[0]![1] as { expiresAt: string }
    expect(Date.parse(saved.expiresAt) - Date.now()).toBeGreaterThan(29.9 * 24 * 3600_000)
    expect(Date.parse(saved.expiresAt) - Date.now()).toBeLessThanOrEqual(30 * 24 * 3600_000)
    expect(JSON.stringify(db.saveMigrateCommentsExport!.mock.calls)).not.toContain(TOKEN)
  })

  it('keeps a fetched export for the grant window even when the download URL expires within minutes', async () => {
    const shortLived = { ...pointer, expires_at: Math.floor(Date.now() / 1000) + 120 }
    const fetchImpl = vi.fn(async () => json(exportPayload))
    await expect(captureClaimCommentsExport({ grantId: 'g-1', pointer: shortLived }, { ...fast, fetchImpl })).resolves.toBe('ready')
    const saved = db.saveMigrateCommentsExport!.mock.calls[0]![1] as { expiresAt: string }
    expect(Date.parse(saved.expiresAt) - Date.now()).toBeGreaterThan(29 * 24 * 3600_000)
  })

  it('falls back to the upload when the env allowlist is empty (the default)', async () => {
    const fetchImpl = vi.fn()
    await expect(captureClaimCommentsExport({ grantId: 'g-1', pointer }, { fetchImpl, retryDelayMs: 0 })).resolves.toBe('unavailable')
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(db.saveMigrateCommentsExport).toHaveBeenCalledWith('g-1', expect.objectContaining({ status: 'unavailable', payload: null, comments: 2 }))
  })

  it('marks it unavailable after two refusals, and logs the failure without the token', async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 401 }))
    await expect(captureClaimCommentsExport({ grantId: 'g-1', pointer }, { ...fast, fetchImpl })).resolves.toBe('unavailable')
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(db.saveMigrateCommentsExport).toHaveBeenCalledWith('g-1', expect.objectContaining({ status: 'unavailable', payload: null }))
    expect(warn).toHaveBeenCalled()
    expect(JSON.stringify(warn.mock.calls)).not.toContain(TOKEN)
  })

  it('records an export the contract dropped as unavailable, naming only the fields', async () => {
    await expect(captureClaimCommentsExport({ grantId: 'g-1', warnings: ['comments_export.token: must be a string (got "leak")'] })).resolves.toBe('unavailable')
    expect(db.saveMigrateCommentsExport).toHaveBeenCalledWith('g-1', expect.objectContaining({ status: 'unavailable', payload: null, comments: 0 }))
    expect(JSON.stringify(warn.mock.calls)).not.toContain('leak')
  })

  it('does nothing without an export, and keeps one that is already held or imported', async () => {
    await expect(captureClaimCommentsExport({ grantId: 'g-1', warnings: ['plan_evidence: ignored'] })).resolves.toBe('none')
    db.getMigrateCommentsExportState!.mockResolvedValue({ grantId: 'g-1', status: 'imported', comments: 2, expiresAt: '', importedAt: '' })
    const fetchImpl = vi.fn()
    await expect(captureClaimCommentsExport({ grantId: 'g-1', pointer }, { ...fast, fetchImpl })).resolves.toBe('kept')
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(db.saveMigrateCommentsExport).not.toHaveBeenCalled()
  })

  it('never throws, even when the database does', async () => {
    db.getMigrateCommentsExportState!.mockRejectedValue(new Error('db down'))
    await expect(captureClaimCommentsExport({ grantId: 'g-1', pointer }, fast)).resolves.toBe('unavailable')
  })
})

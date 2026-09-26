import { createHash } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createMediaIngestContext, ingestMediaBytes } from '../../server/utils/media-bulk-ingest'
import { inspectRepoMedia, normalizeRepoFilename, REPO_MEDIA_MAX_PIXELS } from '../../server/utils/media-ingest'
import { parseMigrationMediaManifest, planMigrationMediaPreflight, readMigrationMediaManifest, verifiedMediaOrigin } from '../../server/utils/migration-media'
import { sanitizeSvg, svgProblems } from '../../server/utils/svg-sanitize'

/**
 * Migrated media → Studio Media, part (a): the repository as a media source
 * (bytes checked like any upload), Migrate's `media.json` read strictly, and
 * the preflight that says what a move would take on this plan.
 */

beforeEach(() => {
  vi.stubGlobal('errorMessage', (key: string, params?: Record<string, unknown>) => (params ? `${key} ${JSON.stringify(params)}` : key))
  vi.stubGlobal('createError', (input: { statusCode: number, message: string }) => Object.assign(new Error(input.message), { statusCode: input.statusCode }))
})

// Migrate's own vectors, verbatim (migrate `packages/media/tests/media.test.ts`, 'SVG temizleme'): one rule set, one test set.
const NS = 'xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"'
const MALICIOUS: Array<[string, string]> = [
  ['script', `<svg ${NS}><script>alert(1)</script><path d="M0 0"/></svg>`],
  ['prefixed script', `<svg ${NS} xmlns:x="http://www.w3.org/2000/svg"><x:script>alert(1)</x:script></svg>`],
  ['CDATA script', `<svg ${NS}><script type="text/javascript"><![CDATA[alert(1)]]></script></svg>`],
  ['event attribute', `<svg ${NS} onload="alert(1)"><rect ONCLICK='x()' width="1"/></svg>`],
  ['javascript href', `<svg ${NS}><a href="javascript:alert(1)"><text>x</text></a></svg>`],
  ['encoded javascript', `<svg ${NS}><a xlink:href="&#106;avascript&#58;alert(1)"><text>x</text></a></svg>`],
  ['spaced javascript', `<svg ${NS}><a href=" java\tscript:alert(1)"><text>x</text></a></svg>`],
  ['control-char javascript', `<svg ${NS}><a href="java\u0001script:alert(1)"><text>x</text></a></svg>`],
  ['external use', `<svg ${NS}><use href="https://evil.test/s.svg#i"/></svg>`],
  ['foreignObject', `<svg ${NS}><foreignObject><iframe src="https://evil.test"></iframe></foreignObject></svg>`],
  ['href animation', `<svg ${NS}><a href="#x"><set attributeName="href" to="javascript:alert(1)"/><text>x</text></a></svg>`],
  ['style import', `<svg ${NS}><style>@import url(https://evil.test/a.css); .a{fill:red}</style></svg>`],
  ['style external url', `<svg ${NS}><rect style="fill:url(https://evil.test/p.svg#g)" width="1"/></svg>`],
  ['XXE', `<?xml version="1.0"?><!DOCTYPE svg [<!ENTITY x SYSTEM "file:///etc/passwd">]><svg ${NS}><text>t</text></svg>`],
  ['processing instruction', `<?xml-stylesheet href="https://evil.test/a.xsl"?><svg ${NS}/>`],
  ['iframe', `<svg ${NS}><iframe src="https://evil.test"/></svg>`],
  // Review S1 (Studio #362, shared) — the allow-list
  ['XHTML meta refresh', `<svg ${NS}><foo xmlns="http://www.w3.org/1999/xhtml"><meta http-equiv="refresh" content="0;url=https://evil.test/"/></foo><path d="M0 0"/></svg>`],
  ['xhtml namespace inside svg', `<svg ${NS}><g xmlns="http://www.w3.org/1999/xhtml"><meta http-equiv="refresh" content="0;url=https://evil.test/"/></g></svg>`],
  ['html img', `<svg ${NS}><img src="https://evil.test/t.gif"/></svg>`],
  ['html:-prefixed iframe', `<svg ${NS} xmlns:html="http://www.w3.org/1999/xhtml"><html:iframe src="https://evil.test"/></svg>`],
  ['CSS escape u\\72l', `<svg ${NS}><rect style="fill:u\\72l(https://evil.test/p)" width="1"/></svg>`],
  ['CSS escape \\75 rl', `<svg ${NS}><style>rect{fill:\\75 rl(https://evil.test/p)}</style></svg>`],
  ['CSS-escaped import', `<svg ${NS}><style>\\@import url(https://evil.test/a.css);</style></svg>`],
  ['comment-split url', `<svg ${NS}><style>rect{fill:ur/**/l(https://evil.test/x)}</style></svg>`],
  ['CSS image-set', `<svg ${NS}><rect style="fill:image-set('https://evil.test/a.png' 1x)" width="1"/></svg>`],
  ['XML-entity CSS', `<svg ${NS}><rect style="fill:u&#114;l(https://evil.test/p)" width="1"/></svg>`],
  ['external url in a presentation attribute', `<svg ${NS}><rect fill="url(https://evil.test/p#g)" width="1"/></svg>`],
  ['entity-encoded href animation', `<svg ${NS}><a><animate attributeName="xlink:h&#114;ef" to="javascript:alert(1)"/></a></svg>`],
  ['breaking out of <style> with escapes', `<svg ${NS}><style>\\3c /style\\3e \\3c script\\3e alert(1)</style></svg>`],
]

const clean = (svg: string): string => {
  const r = sanitizeSvg(Buffer.from(svg))
  if (!r.ok) throw new Error(r.reason)
  return r.bytes.toString('utf8')
}

describe('SVG sanitizing (the rule set shared with Migrate)', () => {
  for (const [name, svg] of MALICIOUS) {
    it(`malicious: ${name} → cleaned and passes the check`, () => {
      const out = clean(svg)
      expect(svgProblems(Buffer.from(out))).toBeNull()
      expect(out).not.toMatch(/script|javascript|onload|onclick|evil\.test|ENTITY|foreignObject|iframe|@import|<meta|refresh|<img|<foo/i)
      expect(out).toMatch(/^(<\?xml[^>]*\?>)?<svg/)
    })
  }

  it('a harmless SVG stays byte-identical: in-document refs, gradient, style', () => {
    const svg = `<svg ${NS} viewBox="0 0 10 10"><defs><linearGradient id="g"><stop offset="0" stop-color="#fff"/></linearGradient><style>.a{fill:url(#g)}</style></defs><rect class="a" fill="url(#g)" width="10" height="10" style="opacity:0.5"/><use xlink:href="#g"/><text x="1" y="2" aria-label="t">A &amp; B</text></svg>`
    const r = sanitizeSvg(Buffer.from(svg))
    expect(r.ok && r.bytes.toString('utf8')).toBe(svg)
    expect(r.ok && r.removed).toEqual([])
  })

  it('Inkscape/sodipodi metadata goes with its content, the drawing stays; a data: image is reported', () => {
    const svg = `<svg ${NS} xmlns:sodipodi="http://sodipodi.sourceforge.net/DTD/sodipodi-0.dtd" xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape" xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><metadata><rdf:RDF><rdf:Description about="https://evil.test"/></rdf:RDF></metadata><sodipodi:namedview inkscape:zoom="1"/><path d="M0 0L1 1" inkscape:label="x"/><image href="data:image/png;base64,AAAA" width="1"/></svg>`
    const r = sanitizeSvg(Buffer.from(svg))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.bytes.toString('utf8')).toBe('<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><path d="M0 0L1 1"/><image width="1"/></svg>')
    expect(r.removed).toEqual(expect.arrayContaining(['<metadata>', '<sodipodi:namedview>', 'href']))
  })

  it('malformed XML cannot be cleaned', () => {
    expect(sanitizeSvg(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><g><path d="M0 0"/></svg>')).ok).toBe(false)
    expect(sanitizeSvg(Buffer.from('<svg><rect/></svg><svg/>')).ok).toBe(false)
    expect(sanitizeSvg(Buffer.from('<svg>a < b</svg>')).ok).toBe(false)
  })
})

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4b00000000049454e44ae426082', 'hex')

describe('inspectRepoMedia — a repository file is checked like any upload', () => {
  const MB = 1024 * 1024

  it('takes the type from the bytes and rebuilds the name from the path', async () => {
    const out = await inspectRepoMedia({ buffer: PNG, repoPath: 'public/media/2024/05/My Photo (1).PNG', declaredMime: 'image/png', maxBytes: MB })
    expect(out.contentType).toBe('image/png')
    expect(out.filename).toBe('My-Photo-1.png')
  })

  it('a file whose bytes are not what it is listed as is refused', async () => {
    await expect(inspectRepoMedia({ buffer: PNG, repoPath: 'public/media/a.jpg', declaredMime: 'image/jpeg', maxBytes: MB }))
      .rejects.toMatchObject({ statusCode: 400, message: expect.stringContaining('media.content_mismatch') })
  })

  it('bytes that are no allowed type (a script, an HTML page named .svg) are refused', async () => {
    for (const text of ['#!/bin/sh\nrm -rf /', '<html><script>alert(1)</script></html>'])
      await expect(inspectRepoMedia({ buffer: Buffer.from(text), repoPath: 'public/media/x.svg', maxBytes: MB })).rejects.toMatchObject({ statusCode: 400 })
  })

  it('an SVG is sanitized before it is stored; one that cannot be made safe is refused', async () => {
    const dirty = await inspectRepoMedia({ buffer: Buffer.from(`<svg ${NS} onload="alert(1)"><path d="M0 0"/></svg>`), repoPath: 'public/media/logo.svg', declaredMime: 'image/svg+xml', maxBytes: MB })
    expect(dirty.contentType).toBe('image/svg+xml')
    expect(dirty.buffer.toString('utf8')).not.toContain('onload')
    await expect(inspectRepoMedia({ buffer: Buffer.from(`<svg ${NS}><g></svg>`), repoPath: 'public/media/broken.svg', maxBytes: MB }))
      .rejects.toMatchObject({ message: expect.stringContaining('media.svg_unsafe') })
  })

  it('over the plan\'s file cap, empty, or declaring more pixels than the optimizer decodes: refused', async () => {
    await expect(inspectRepoMedia({ buffer: PNG, repoPath: 'public/media/a.png', maxBytes: 10 })).rejects.toMatchObject({ message: expect.stringContaining('media.file_too_large') })
    await expect(inspectRepoMedia({ buffer: Buffer.alloc(0), repoPath: 'public/media/a.png', maxBytes: MB })).rejects.toMatchObject({ statusCode: 400 })
    await expect(inspectRepoMedia({ buffer: PNG, repoPath: 'public/media/a.png', maxBytes: MB, width: 20_000, height: REPO_MEDIA_MAX_PIXELS / 10_000 }))
      .rejects.toMatchObject({ message: expect.stringContaining('media.image_too_many_pixels') })
  })

  it('a name with nothing usable left still gets one, with the extension its content has', () => {
    expect(normalizeRepoFilename('public/media/…/.jpg', 'image/webp')).toBe('migrated-file.webp')
    expect(normalizeRepoFilename('public/media/../../etc/passwd', 'image/png')).toBe('passwd.png')
  })
})

const sha = (s: string) => createHash('sha256').update(s).digest('hex')
const asset = (over: Record<string, unknown> = {}) => ({
  id: 'a1',
  role: 'media',
  repoPath: 'public/media/a.png',
  localUrl: '/media/a.png',
  sourceUrl: 'https://old.example/wp-content/uploads/a.png',
  sha256: sha('a'),
  bytes: 100,
  mime: 'image/png',
  refs: [{ file: 'content/blog/en.json', pointer: '/post-1/cover', match: 'exact' }],
  ...over,
})

describe('media.json — read strictly where it matters', () => {
  it('parses Migrate\'s manifest and ignores fields it does not know', () => {
    const m = parseMigrationMediaManifest({ version: 1, origin: 'https://old.example', assets: [asset({ future: true })], studioRecommended: [] })
    expect(m.assets[0]).toMatchObject({ id: 'a1', role: 'media', repoPath: 'public/media/a.png', bytes: 100, refs: [{ match: 'exact' }] })
    expect(m.assets[0]).not.toHaveProperty('future')
  })

  it('every required field is hard: a missing one names itself', () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ repoPath: undefined }, 'repoPath'],
      [{ sha256: 'nothex' }, 'sha256'],
      [{ bytes: -1 }, 'bytes'],
      [{ mime: '' }, 'mime'],
      [{ refs: undefined }, 'refs'],
      [{ refs: [{ file: 'a.json', pointer: 'no-slash', match: 'exact' }] }, 'pointer'],
      [{ refs: [{ file: 'a.json', pointer: '/x', match: 'fuzzy' }] }, 'match'],
    ]
    for (const [over, field] of cases)
      expect(() => parseMigrationMediaManifest({ version: 1, assets: [asset(over)] })).toThrow(new RegExp(field))
    expect(() => parseMigrationMediaManifest({ version: 2, assets: [] })).toThrow(/version/)
  })

  it('a path that climbs out, is absolute, or sits outside public/media/ for a media asset is refused', () => {
    for (const repoPath of ['../secrets.png', '/etc/passwd', 'public/media/../../.env', 'src/pages/index.astro'])
      expect(() => parseMigrationMediaManifest({ version: 1, assets: [asset({ repoPath })] })).toThrow(/repoPath/)
    // A font stays where Migrate put it (src/assets/fonts/…) and is not moved.
    expect(parseMigrationMediaManifest({ version: 1, assets: [asset({ role: 'font', repoPath: 'src/assets/fonts/site/a.woff2', refs: [] })] }).assets[0]!.role).toBe('font')
  })

  it('is read from the content branch first, then the default branch', async () => {
    const files: Record<string, string> = { 'main:.contentrain/migrate/media.json': JSON.stringify({ version: 1, assets: [asset()] }) }
    const git = { readFile: vi.fn(async (path: string, ref: string) => {
      const hit = files[`${ref}:${path}`]
      if (!hit) throw new Error('not found')
      return hit
    }) }
    const found = await readMigrationMediaManifest(git as never, '', 'main')
    expect(found).toMatchObject({ ref: 'main', path: '.contentrain/migrate/media.json' })
    expect(git.readFile.mock.calls[0]).toEqual(['.contentrain/migrate/media.json', 'contentrain'])
    const absent = { readFile: async () => Promise.reject(new Error('no')) }
    expect(await readMigrationMediaManifest(absent as never, '', 'main')).toBeNull()
  })
})

describe('preflight — what a move would take on this plan', () => {
  const GB = 1024 * 1024 * 1024
  const MB = 1024 * 1024
  // Starter 1 GB / 5 MB, Pro 15 GB / 50 MB (the plan catalog's values).
  const LIMITS: Record<string, Record<string, number>> = {
    starter: { 'media.storage_gb': 1, 'media.max_file_size_mb': 5 },
    pro: { 'media.storage_gb': 15, 'media.max_file_size_mb': 50 },
    enterprise: { 'media.storage_gb': 100, 'media.max_file_size_mb': 100 },
  }
  beforeEach(() => {
    vi.stubGlobal('getPlanLimit', (plan: string, key: string) => LIMITS[plan]?.[key] ?? 0)
    vi.stubGlobal('getPlanLimitForPlan', (plan: string, key: string) => LIMITS[plan]?.[key] ?? 0)
    vi.stubGlobal('getUpgradeParams', (from: string, to: string) => ({ plan: from, toPlan: to }))
  })

  const manifest = (assets: Array<Record<string, unknown>>) => parseMigrationMediaManifest({ version: 1, assets })
  const tree = (entries: Array<[string, number]>) => entries.map(([path, size]) => ({ path, type: 'blob' as const, sha: sha(path), size }))

  it('counts media, keeps fonts out, and fits when there is room', () => {
    const m = manifest([asset(), asset({ repoPath: 'public/media/b.png', bytes: 200 }), asset({ role: 'font', repoPath: 'src/assets/fonts/site/f.woff2', bytes: 50, refs: [] })])
    const p = planMigrationMediaPreflight({ manifest: m, tree: tree([['public/media/a.png', 100], ['public/media/b.png', 200]]), plan: 'starter', usedBytes: 0 })
    expect(p).toMatchObject({ count: 2, totalBytes: 300, fontsKept: 1, refs: 2, fits: true, upgrade: null, overSize: [], missing: [] })
    expect(p.limits).toEqual({ maxFileBytes: 5 * MB, storageBytes: GB })
    expect(p.storage.remainingBytes).toBe(GB)
  })

  it('a file over Starter\'s 5 MB cap is listed and the upgrade names Pro', () => {
    const m = manifest([asset({ bytes: 6 * MB })])
    const p = planMigrationMediaPreflight({ manifest: m, tree: tree([['public/media/a.png', 6 * MB]]), plan: 'starter', usedBytes: 0 })
    expect(p.overSize).toEqual([{ repoPath: 'public/media/a.png', bytes: 6 * MB }])
    expect(p.upgrade).toEqual({ plan: 'pro', params: { plan: 'starter', toPlan: 'pro' } })
  })

  it('not enough room left: does not fit, and the lowest plan that holds it all is named', () => {
    const m = manifest([asset({ bytes: 4 * MB })])
    const p = planMigrationMediaPreflight({ manifest: m, tree: tree([['public/media/a.png', 4 * MB]]), plan: 'starter', usedBytes: GB - MB })
    expect(p.fits).toBe(false)
    expect(p.storage.remainingBytes).toBe(MB)
    expect(p.upgrade?.plan).toBe('pro')
  })

  it('what the branch does not hold as listed is reported, not counted as movable', () => {
    const m = manifest([asset(), asset({ repoPath: 'public/media/b.png', bytes: 200 })])
    const p = planMigrationMediaPreflight({ manifest: m, tree: tree([['public/media/b.png', 999]]), plan: 'starter', usedBytes: 0 })
    expect(p.missing).toEqual([{ repoPath: 'public/media/a.png', reason: 'not_in_repo' }, { repoPath: 'public/media/b.png', reason: 'size_mismatch' }])
  })

  it('a plan with no storage ceiling always fits', () => {
    const p = planMigrationMediaPreflight({ manifest: manifest([asset()]), tree: tree([['public/media/a.png', 100]]), plan: 'community' as never, usedBytes: 10 * GB })
    expect(p).toMatchObject({ fits: true, upgrade: null, limits: { maxFileBytes: null, storageBytes: null }, storage: { remainingBytes: null } })
  })
})

describe('verifiedMediaOrigin — the signed origin, only when the manifest names that site', () => {
  it('takes the origin Migrate signed when the manifest names the same site', () => {
    expect(verifiedMediaOrigin({ origin: 'https://old.example' }, 'https://old.example')).toBe('https://old.example')
    // Compared as origins: a trailing slash or default port in the manifest is the same site.
    expect(verifiedMediaOrigin({ origin: 'https://Old.Example:443/' }, 'https://old.example')).toBe('https://old.example')
  })

  it('gives nothing without a signed origin, without a manifest origin, or when they differ', () => {
    expect(verifiedMediaOrigin({ origin: 'https://old.example' }, null)).toBeNull()
    expect(verifiedMediaOrigin({}, 'https://old.example')).toBeNull()
    for (const other of ['https://evil.example', 'http://old.example', 'https://old.example:8443', 'https://sub.old.example', 'not a url'])
      expect(verifiedMediaOrigin({ origin: other }, 'https://old.example'), other).toBeNull()
  })
})

describe('ingestMediaBytes — the repository source shares the upload path', () => {
  const db = {
    getWorkspaceById: vi.fn().mockResolvedValue({ id: 'ws-1', overage_settings: null }),
    reserveStorageIfAllowed: vi.fn().mockResolvedValue({ allowed: true, currentBytes: 0 }),
    incrementWorkspaceStorageBytes: vi.fn().mockResolvedValue(undefined),
  }
  beforeEach(() => {
    vi.stubGlobal('useDatabaseProvider', () => db)
    vi.stubGlobal('useRuntimeConfig', () => ({ public: { siteUrl: 'https://studio.test' } }))
    vi.stubGlobal('getPlanLimit', (_: string, key: string) => (key === 'media.storage_gb' ? 1 : key === 'media.max_file_size_mb' ? 5 : 5))
    vi.stubGlobal('hasFeature', () => false)
    vi.stubGlobal('emitWebhookEvent', vi.fn().mockResolvedValue(undefined))
    db.reserveStorageIfAllowed.mockReset().mockResolvedValue({ allowed: true, currentBytes: 0 })
  })

  const uploaded = { id: 'as-1', originalPath: 'media/original/as-1.png', size: 60, filename: 'a.png', contentType: 'image/png', variants: {} }

  it('stores with source \'repo\', reserves this file\'s bytes, reconciles to the optimized size', async () => {
    const media = { upload: vi.fn(async () => uploaded) }
    const ctx = await createMediaIngestContext({ projectId: 'p-1', workspaceId: 'ws-1', plan: 'starter', uploadedBy: 'u-1', source: 'repo', media: media as never })
    const out = await ingestMediaBytes(ctx, { ref: 'public/media/a.png', remote: { buffer: PNG, filename: 'a.png', contentType: 'image/png' } })
    expect(out).toMatchObject({ ok: true, url: 'public/media/a.png', assetId: 'as-1' })
    expect(media.upload.mock.calls[0]![0]).toMatchObject({ source: 'repo', skipStorageIncrement: true })
    expect(db.reserveStorageIfAllowed).toHaveBeenCalledWith('ws-1', PNG.length, 1024 * 1024 * 1024)
    expect(db.incrementWorkspaceStorageBytes).toHaveBeenCalledWith('ws-1', 60 - PNG.length)
  })

  it('out of room: this file fails with storage.quota_exceeded and nothing is uploaded', async () => {
    db.reserveStorageIfAllowed.mockResolvedValue({ allowed: false, currentBytes: 0 })
    const media = { upload: vi.fn() }
    const ctx = await createMediaIngestContext({ projectId: 'p-1', workspaceId: 'ws-1', plan: 'starter', uploadedBy: 'u-1', source: 'repo', media: media as never })
    const out = await ingestMediaBytes(ctx, { ref: 'public/media/a.png', remote: { buffer: PNG, filename: 'a.png', contentType: 'image/png' } })
    expect(out).toMatchObject({ ok: false, statusCode: 403, error: 'storage.quota_exceeded' })
    expect(media.upload).not.toHaveBeenCalled()
  })

  it('bytes the project already holds: the existing asset, no quota, no upload', async () => {
    const media = { upload: vi.fn(), getAssetByContentHash: vi.fn(async () => uploaded) }
    const ctx = await createMediaIngestContext({ projectId: 'p-1', workspaceId: 'ws-1', plan: 'starter', uploadedBy: 'u-1', source: 'repo', media: media as never })
    const out = await ingestMediaBytes(ctx, { ref: 'public/media/a.png', remote: { buffer: PNG, filename: 'a.png', contentType: 'image/png' } })
    expect(out).toMatchObject({ ok: true, deduped: true, assetId: 'as-1' })
    expect(media.getAssetByContentHash).toHaveBeenCalledWith('p-1', createHash('sha256').update(PNG).digest('hex'))
    expect(db.reserveStorageIfAllowed).not.toHaveBeenCalled()
    expect(media.upload).not.toHaveBeenCalled()
  })
})

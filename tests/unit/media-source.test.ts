import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import sharp from 'sharp'
import { createSharpMediaProvider } from '../../ee/media/sharp-processor'
import { isMediaSourcePath, mediaSourcePath, MEDIA_SOURCE_PREFIX } from '../../server/utils/media-source'
import { withMediaUrls } from '../../server/utils/media-url'
import { looksLikeSvg } from '../../server/utils/svg-sanitize'
import { resolveVariantConfig } from '../../server/utils/media-variants'
import type { CDNProvider } from '../../server/providers/cdn'
import type { DatabaseProvider, DatabaseRow } from '../../server/providers/database'

vi.stubGlobal('useRuntimeConfig', () => ({ public: { siteUrl: 'https://studio.example' } }))
vi.stubGlobal('createError', (e: { statusCode: number, message: string }) => Object.assign(new Error(e.message), e))

/** In-memory CDN + DB: only what the processor touches. */
function harness(opts: { failInsert?: boolean } = {}) {
  const objects = new Map<string, Buffer>()
  const rows = new Map<string, DatabaseRow>()
  const storageDeltas: number[] = []
  const cdn = {
    putObject: vi.fn(async (_p: string, path: string, data: Buffer) => { objects.set(path, data) }),
    getObject: vi.fn(async (_p: string, path: string) => {
      const data = objects.get(path)
      return data ? { data, contentType: 'application/octet-stream', etag: 'x' } : null
    }),
    deleteObject: vi.fn(async (_p: string, path: string) => { objects.delete(path) }),
  } as unknown as CDNProvider
  const db = {
    createMediaAsset: vi.fn(async (input: DatabaseRow) => {
      if (opts.failInsert) throw new Error('insert failed')
      const row = { ...input, id: [...objects.keys()].find(k => k.startsWith('media/original/'))!.split('/').pop()!.split('.')[0], created_at: 't', updated_at: 't' }
      rows.set(row.id as string, row)
      return row
    }),
    getMediaAsset: vi.fn(async (id: string) => rows.get(id) ?? null),
    getMediaUsage: vi.fn(async () => []),
    updateMediaAsset: vi.fn(async (id: string, patch: DatabaseRow) => {
      const next = { ...rows.get(id)!, ...patch }
      rows.set(id, next)
      return next
    }),
    deleteMediaAsset: vi.fn(async (id: string) => { rows.delete(id) }),
    incrementWorkspaceStorageBytes: vi.fn(async (_w: string, n: number) => { storageDeltas.push(n) }),
  } as unknown as DatabaseProvider
  return { provider: createSharpMediaProvider({ cdn, db }), objects, rows, storageDeltas, cdn, db }
}

async function jpeg(width: number, height: number): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: { r: 10, g: 120, b: 200 } } })
    .jpeg()
    .withMetadata({ exif: { IFD0: { Copyright: 'camera-data' } } })
    .toBuffer()
}

const upload = (file: Buffer, contentType = 'image/jpeg', variants = {}) => ({
  projectId: 'p1',
  workspaceId: 'w1',
  file,
  filename: 'photo.jpg',
  contentType,
  uploadedBy: 'u1',
  variants,
})

describe('media source path', () => {
  it('lives outside the public media/ prefix', () => {
    expect(MEDIA_SOURCE_PREFIX.startsWith('media/')).toBe(false)
    expect(mediaSourcePath('a1', 'image/jpeg')).toBe('media-source/a1.jpg')
    expect(mediaSourcePath('a1', 'image/png')).toBe('media-source/a1.png')
    expect(mediaSourcePath('a1', 'image/x-weird')).toBe('media-source/a1.bin')
    expect(isMediaSourcePath('media-source/a1.jpg')).toBe(true)
    expect(isMediaSourcePath('media/original/a1.webp')).toBe(false)
  })
})

describe('upload keeps the source apart from the delivery master', () => {
  it('stores a byte-identical source, a ≤4096 px master, and counts both toward the quota', async () => {
    const { provider, objects, storageDeltas } = harness()
    const file = await sharp({ create: { width: 5000, height: 3000, channels: 3, background: '#336699' } })
      .jpeg()
      .withMetadata({ exif: { IFD0: { Copyright: 'camera-data' } } })
      .toBuffer()

    const asset = await provider.upload(upload(file))

    expect(asset.sourcePath).toBe(`media-source/${asset.id}.jpg`)
    expect(createHash('sha256').update(objects.get(asset.sourcePath!)!).digest('hex')).toBe(asset.contentHash)
    expect(objects.get(asset.sourcePath!)!.equals(file)).toBe(true)
    expect(asset.sourceSize).toBe(file.length)

    expect(asset.width).toBeLessThanOrEqual(4096)
    expect(asset.originalPath.startsWith('media/original/')).toBe(true)
    expect((await sharp(objects.get(asset.originalPath)!).metadata()).width).toBeLessThanOrEqual(4096)

    const variantBytes = Object.values(asset.variants).reduce((s, v) => s + v.size, 0)
    const master = objects.get(asset.originalPath)!.length
    expect(asset.size).toBe(master + variantBytes + file.length)
    expect(storageDeltas).toEqual([asset.size])
  })

  it('stores no source for non-image files', async () => {
    const { provider, objects } = harness()
    const asset = await provider.upload(upload(Buffer.from('%PDF-1.4'), 'application/pdf'))
    expect(asset.sourcePath).toBeNull()
    expect(asset.sourceSize).toBeNull()
    expect([...objects.keys()].some(isMediaSourcePath)).toBe(false)
  })

  it('removes the source and the master when the DB insert fails', async () => {
    const { provider, objects } = harness({ failInsert: true })
    await expect(provider.upload(upload(await jpeg(300, 200)))).rejects.toThrow('insert failed')
    expect(objects.size).toBe(0)
  })

  it('delete removes the source too and returns the whole footprint', async () => {
    const { provider, objects, storageDeltas } = harness()
    const asset = await provider.upload(upload(await jpeg(300, 200), 'image/jpeg', resolveVariantConfig('thumbnail')))
    storageDeltas.length = 0

    await provider.delete('p1', asset.id)

    expect(objects.size).toBe(0)
    expect(storageDeltas).toEqual([-asset.size])
  })

  it('regenerating variants regenerates from the master and leaves the source untouched', async () => {
    const { provider, objects } = harness()
    const file = await jpeg(1200, 800)
    const asset = await provider.upload(upload(file))
    const before = Buffer.from(objects.get(asset.sourcePath!)!)

    const next = await provider.regenerateVariants(asset.id, resolveVariantConfig('hero-image'))

    expect(Object.keys(next.variants).length).toBeGreaterThan(0)
    expect(next.sourcePath).toBe(asset.sourcePath)
    expect(objects.get(asset.sourcePath!)!.equals(before)).toBe(true)
  })

  it('a row without a source (earlier upload) maps to null, not a guess', async () => {
    const { provider, rows } = harness()
    const asset = await provider.upload(upload(await jpeg(100, 100)))
    rows.set(asset.id, { ...rows.get(asset.id)!, source_path: null, source_size_bytes: null })
    const again = await provider.getAsset(asset.id)
    expect(again!.sourcePath).toBeNull()
    expect(again!.sourceSize).toBeNull()
  })
})

describe('public shapes never carry the source', () => {
  it('withMediaUrls drops sourcePath and sourceSize', async () => {
    const { provider } = harness()
    const asset = await provider.upload(upload(await jpeg(100, 100)))
    const shaped = withMediaUrls('p1', asset)
    expect(shaped).not.toHaveProperty('sourcePath')
    expect(shaped).not.toHaveProperty('sourceSize')
    expect(JSON.stringify(shaped)).not.toContain('media-source')
  })
})

const INKSCAPE_SVG = `<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape" xmlns:sodipodi="http://sodipodi.sourceforge.net/DTD/sodipodi-0.dtd" xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:dc="http://purl.org/dc/elements/1.1/" viewBox="0 0 100 50" width="100" height="50" inkscape:version="1.2" sodipodi:docname="/Users/jane/secret/logo.svg" onload="alert(1)"><title>Logo</title><metadata><rdf:RDF><dc:creator>Jane Doe</dc:creator></rdf:RDF></metadata><sodipodi:namedview inkscape:window-width="1"/><script>alert(1)</script><defs><linearGradient id="g" x1="0" x2="1"><stop offset="0" stop-color="#f00"/><stop offset="1" stop-color="#00f"/></linearGradient><path id="p" d="M0 0h10v10z"/></defs><rect width="100" height="50" fill="url(#g)" onclick="x()"/><a xlink:href="javascript:alert(1)"><circle r="3"/></a><use xlink:href="#p" x="5"/></svg>`

describe('SVG upload is sanitised at the provider, whatever the declared type', () => {
  it.each(['image/svg+xml', 'image/png', 'application/pdf'])('stores the cleaned form (declared %s)', async (declared) => {
    const { provider, objects } = harness()
    const asset = await provider.upload({ ...upload(Buffer.from(INKSCAPE_SVG), declared), filename: 'logo.png' })
    const stored = objects.get(asset.originalPath)!.toString()

    expect(asset.contentType).toBe('image/svg+xml')
    expect(asset.format).toBe('svg')
    expect(asset.originalPath.endsWith('.svg')).toBe(true)
    // active content and metadata are gone
    expect(stored).not.toMatch(/<script|onload|onclick|javascript:|<metadata|rdf:|dc:|Jane|sodipodi|inkscape|\/Users\/jane/i)
    // the render survives
    expect(stored).toContain('viewBox="0 0 100 50"')
    expect(stored).toContain('<linearGradient id="g"')
    expect(stored).toContain('fill="url(#g)"')
    expect(stored).toContain('<defs>')
    expect(stored).toContain('<use xlink:href="#p"')
    expect(stored).toContain('<title>Logo</title>')
    // `<a>` is not in the allow-list: the link and what it wraps are dropped
    expect(stored).not.toMatch(/<a[\s>]|<circle/)
    // hash and size describe the stored bytes, and no private source is kept for an SVG
    expect(asset.contentHash).toBe(createHash('sha256').update(objects.get(asset.originalPath)!).digest('hex'))
    expect(asset.size).toBe(objects.get(asset.originalPath)!.length)
    expect(asset.sourcePath).toBeNull()
  })

  it('refuses an SVG that cannot be made well-formed', async () => {
    const { provider, objects } = harness()
    await expect(provider.upload(upload(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><g><path d="M0 0"/></svg>'), 'image/svg+xml')))
      .rejects.toMatchObject({ statusCode: 400 })
    expect(objects.size).toBe(0)
  })

  it('does not treat a raster as an SVG', async () => {
    const { provider } = harness()
    const asset = await provider.upload(upload(await jpeg(100, 100)))
    expect(asset.contentType).toBe('image/jpeg')
    expect(asset.sourcePath).not.toBeNull()
  })
})

// Documents a parser reads as SVG that a narrow sniff misses. Each one carries active content and is declared as
// something that is stored as sent (video / pdf), so the cleaned form is the only safe outcome.
const ACTIVE = '<rect width="10" height="10" onclick="x()"/><script>alert(1)</script>'
const NS = 'xmlns="http://www.w3.org/2000/svg"'
const SNIFF_CASES: Record<string, string> = {
  'a DOCTYPE with an internal subset': `<?xml version="1.0"?><!DOCTYPE svg [ <!ENTITY note "a>b"> <!ELEMENT svg ANY> ]><svg ${NS} onload="alert(1)">${ACTIVE}</svg>`,
  'a comment holding "]" in the internal subset': `<!DOCTYPE svg [ <!-- ] --> <!ENTITY a "x"> ]><svg ${NS} onload="alert(1)">${ACTIVE}</svg>`,
  'a processing instruction holding "]" in the internal subset': `<!DOCTYPE svg [ <?x ] ?> ]><svg ${NS} onload="alert(1)">${ACTIVE}</svg>`,
  'a prefixed root (<svg:svg>)': `<svg:svg xmlns:svg="http://www.w3.org/2000/svg" onload="alert(1)"><svg:script>alert(1)</svg:script><svg:rect width="10" height="10" onclick="x()"/></svg:svg>`,
  'a comment before the XML declaration': `<!-- exported --><?xml version="1.0"?><svg ${NS} onload="alert(1)">${ACTIVE}</svg>`,
}

describe('SVG detection follows the parser, not a pattern', () => {
  it.each(Object.keys(SNIFF_CASES))('treats %s as an SVG, and never stores it as sent', async (name) => {
    expect(looksLikeSvg(Buffer.from(SNIFF_CASES[name]!))).toBe(true)
    for (const declared of ['video/mp4', 'application/pdf']) {
      const { provider, objects } = harness()
      const sent = Buffer.from(SNIFF_CASES[name]!)
      // Either the cleaned form is stored, or the sanitiser refuses a subset it cannot read; the bytes as sent never are.
      const outcome = await provider.upload({ ...upload(sent, declared), filename: 'clip.mp4' }).then(asset => ({ asset }), (error: unknown) => ({ error }))
      if ('asset' in outcome) {
        const stored = objects.get(outcome.asset.originalPath)!.toString()
        expect(outcome.asset.contentType).toBe('image/svg+xml')
        expect(stored).not.toMatch(/<[\w:]*script|onload|onclick|alert|<!DOCTYPE|<!ENTITY/i)
      }
      else {
        expect(outcome.error).toMatchObject({ statusCode: 400 })
        expect(objects.size).toBe(0)
      }
    }
  })

  const utf16le = Buffer.concat([Buffer.from([0xFF, 0xFE]), Buffer.from(`<svg ${NS}>${ACTIVE}</svg>`, 'utf16le')])
  const utf16be = Buffer.from(`<svg ${NS}>${ACTIVE}</svg>`, 'utf16le').swap16()
  it.each([['UTF-16 LE with a BOM', utf16le], ['UTF-16 BE without a BOM', utf16be]] as const)('refuses %s instead of storing it as sent', async (_name, file) => {
    for (const declared of ['video/mp4', 'application/pdf', 'image/svg+xml']) {
      const { provider, objects } = harness()
      await expect(provider.upload(upload(file, declared))).rejects.toMatchObject({ statusCode: 400 })
      expect(objects.size).toBe(0)
    }
  })

  it('reads the root element, nothing looser', () => {
    expect(looksLikeSvg(Buffer.from(`\uFEFF  <!-- a -->\n<?xml version="1.0"?>\n<!-- b --><!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd"><svg ${NS}/>`))).toBe(true)
    // an unfinished prolog is not waved through
    expect(looksLikeSvg(Buffer.from('<!DOCTYPE svg [ <!ENTITY a "'))).toBe(true)
    expect(looksLikeSvg(Buffer.from('<html><body><svg></svg></body></html>'))).toBe(false)
    expect(looksLikeSvg(Buffer.from('<svgx/>'))).toBe(false)
    expect(looksLikeSvg(Buffer.from('%PDF-1.4 <svg>'))).toBe(false)
    expect(looksLikeSvg(Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70]))).toBe(false)
  })
})

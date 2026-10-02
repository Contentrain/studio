import { describe, expect, it, vi } from 'vitest'
import sharp from 'sharp'
import { exifHasGps, inspectWebp, stripWebpMetadata } from '../../ee/media/webp-metadata'
import { formatSweepReport, purgeList, runMetadataSweep, type SweepAsset, type SweepChange, type SweepStore } from '../../ee/media/metadata-sweep'
import type { CDNProvider } from '../../server/providers/cdn'

/** A real WebP carrying camera EXIF (with a GPS block) and XMP, as an upload before #384 was published. */
async function webpWithMetadata(opts: { animated?: boolean } = {}): Promise<Buffer> {
  const frame = (colour: string) => sharp({ create: { width: 64, height: 48, channels: 3, background: colour } }).raw().toBuffer()
  const base = opts.animated
    ? sharp(Buffer.concat([await frame('#ff0000'), await frame('#0000ff')]), { raw: { width: 64, height: 48 * 2, channels: 3, pageHeight: 48 } as never })
    : sharp({ create: { width: 64, height: 48, channels: 3, background: '#3366aa' } })
  return await base
    .webp({ quality: 80, ...(opts.animated ? { loop: 0, delay: [100, 100] } : {}) })
    .withExif({ IFD0: { Make: 'ACME', Copyright: 'owner' }, IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '41/1 0/1 0/1', GPSLongitudeRef: 'E', GPSLongitude: '29/1 0/1 0/1' } })
    .withXmp('<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"/></x:xmpmeta>')
    .toBuffer()
}

const pixels = async (buf: Buffer) => await sharp(buf, { animated: true }).raw().toBuffer({ resolveWithObject: true })

describe('lossless WebP metadata removal', () => {
  it('finds EXIF, GPS and XMP in a real WebP', async () => {
    const webp = await webpWithMetadata()
    expect(inspectWebp(webp)).toEqual({ exif: true, gps: true, xmp: true })
    expect((await sharp(webp).metadata()).exif).toBeDefined()
  })

  it.each([false, true])('drops EXIF/XMP and nothing else (animated: %s)', async (animated) => {
    const webp = await webpWithMetadata({ animated })
    const result = stripWebpMetadata(webp)!

    expect(result.changed).toBe(true)
    expect(result.buffer.length).toBeLessThan(webp.length)
    expect(inspectWebp(result.buffer)).toEqual({ exif: false, gps: false, xmp: false })
    const meta = await sharp(result.buffer, { animated: true }).metadata()
    expect(meta.exif).toBeUndefined()
    expect(meta.xmp).toBeUndefined()
    // The RIFF size is consistent and the pixels (every frame) are identical: no re-encode happened.
    expect(result.buffer.readUInt32LE(4)).toBe(result.buffer.length - 8)
    const [a, b] = await Promise.all([pixels(webp), pixels(result.buffer)])
    expect(b.info).toEqual(a.info)
    expect(b.data.equals(a.data)).toBe(true)
    if (animated) expect(meta.pages).toBe(2)
  })

  it('is a no-op on a clean WebP and refuses what is not a WebP', async () => {
    const clean = stripWebpMetadata(await webpWithMetadata())!.buffer
    const again = stripWebpMetadata(clean)!
    expect(again.changed).toBe(false)
    expect(again.buffer).toBe(clean)
    expect(stripWebpMetadata(Buffer.from('not a webp at all'))).toBeNull()
    expect(inspectWebp(Buffer.concat([clean.subarray(0, 20), Buffer.alloc(4)]))).not.toBeUndefined()
    // A chunk that runs past the end of the file: damaged, left alone.
    const damaged = Buffer.from(clean)
    damaged.writeUInt32LE(0x7fffffff, 16)
    expect(stripWebpMetadata(damaged)).toBeNull()
  })

  it('reads a GPS pointer from raw TIFF with and without the Exif prefix, both byte orders', () => {
    const tiff = (le: boolean, tag: number) => {
      const b = Buffer.alloc(8 + 2 + 12 + 4)
      b.write(le ? 'II' : 'MM', 0, 'latin1')
      const u16 = (value: number, offset: number) => (le ? b.writeUInt16LE(value, offset) : b.writeUInt16BE(value, offset))
      const u32 = (value: number, offset: number) => (le ? b.writeUInt32LE(value, offset) : b.writeUInt32BE(value, offset))
      u16(42, 2)
      u32(8, 4)
      u16(1, 8)
      u16(tag, 10)
      return b
    }
    for (const le of [true, false]) {
      expect(exifHasGps(tiff(le, 0x8825))).toBe(true)
      expect(exifHasGps(tiff(le, 0x010f))).toBe(false)
      expect(exifHasGps(Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff(le, 0x8825)]))).toBe(true)
    }
    expect(exifHasGps(Buffer.from('garbage'))).toBe(false)
  })
})

const SVG_RAW = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><metadata>Jane Doe</metadata><script>alert(1)</script><rect width="10" height="10"/></svg>'

function world(files: Record<string, { data: Buffer, contentType: string }>, assets: SweepAsset[]) {
  const objects = new Map(Object.entries(files))
  const key = (p: string, path: string) => `${p}:${path}`
  const stored = new Map(Object.entries(files).map(([k, v]) => [k, v]))
  const cdn = {
    getObject: vi.fn(async (p: string, path: string) => stored.get(key(p, path)) ? { ...stored.get(key(p, path))!, etag: 'e' } : null),
    putObject: vi.fn(async (p: string, path: string, data: Buffer, contentType: string) => {
      stored.set(key(p, path), { data, contentType })
      return { path, size: data.length, contentType, etag: 'n' }
    }),
  } as unknown as CDNProvider
  const changes: SweepChange[] = []
  const store: SweepStore = {
    listAssets: async (after, limit, projectId) => assets.filter(a => (after === null || a.id > after) && (!projectId || a.project_id === projectId)).sort((x, y) => x.id.localeCompare(y.id)).slice(0, limit),
    applyChange: async (change) => {
      changes.push(change)
    },
  }
  return { cdn, store, changes, stored, objects }
}

const asset = (id: string, path: string, over: Partial<SweepAsset> = {}): SweepAsset => ({ id, project_id: 'p1', workspace_id: 'w1', content_type: 'image/webp', original_path: path, variants: null, ...over })

describe('metadata sweep', () => {
  it('dry run reports and writes nothing; apply rewrites, fixes the size and lists the URLs; a rerun finds nothing', async () => {
    const dirty = await webpWithMetadata()
    const clean = stripWebpMetadata(dirty)!.buffer
    const w = world({
      'p1:media/original/a.webp': { data: dirty, contentType: 'image/webp' },
      'p1:media/original/b.webp': { data: clean, contentType: 'image/webp' },
      'p1:media/original/c.png': { data: Buffer.from('png'), contentType: 'image/png' },
    }, [asset('1', 'media/original/a.webp'), asset('2', 'media/original/b.webp'), asset('3', 'media/original/c.png', { content_type: 'image/png' })])
    const opts = { store: w.store, cdn: w.cdn, siteUrl: 'https://studio.example/' }

    const dry = await runMetadataSweep(opts)
    expect(dry).toMatchObject({ mode: 'dry-run', assetsScanned: 3, filesScanned: 2, webpWithMetadata: 1, webpWithGps: 1, filesRewritten: 0 })
    expect(dry.urls).toEqual(['https://studio.example/api/cdn/v1/p1/media/original/a.webp'])
    expect(dry.bytesFreed).toBe(dirty.length - clean.length)
    expect(w.cdn.putObject).not.toHaveBeenCalled()
    expect(w.changes).toEqual([])

    const applied = await runMetadataSweep({ ...opts, dryRun: false })
    expect(applied).toMatchObject({ mode: 'apply', filesRewritten: 1, bytesFreed: dirty.length - clean.length })
    expect(w.changes).toEqual([{ assetId: '1', workspaceId: 'w1', sizeDelta: clean.length - dirty.length }])
    expect(inspectWebp(w.stored.get('p1:media/original/a.webp')!.data)).toEqual({ exif: false, gps: false, xmp: false })
    expect(w.stored.get('p1:media/original/a.webp')!.contentType).toBe('image/webp')

    const rerun = await runMetadataSweep({ ...opts, dryRun: false })
    expect(rerun).toMatchObject({ webpWithMetadata: 0, filesRewritten: 0, urls: [] })
  })

  it('re-sanitises a stored SVG, updates its hash, and reports one it cannot make safe', async () => {
    const w = world({
      'p1:media/original/a.svg': { data: Buffer.from(SVG_RAW), contentType: 'image/svg+xml' },
      'p1:media/original/b.svg': { data: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><g></svg>'), contentType: 'image/svg+xml' },
    }, [asset('1', 'media/original/a.svg', { content_type: 'image/svg+xml' }), asset('2', 'media/original/b.svg', { content_type: 'image/svg+xml' })])

    const report = await runMetadataSweep({ store: w.store, cdn: w.cdn, siteUrl: 'https://s.example', dryRun: false })

    expect(report.svgNeedingClean).toBe(1)
    expect(report.svgUnsafe).toHaveLength(1)
    expect(report.svgUnsafe[0]).toMatchObject({ assetId: '2', path: 'media/original/b.svg' })
    const stored = w.stored.get('p1:media/original/a.svg')!.data.toString()
    expect(stored).not.toMatch(/script|metadata|Jane/)
    expect(stored).toContain('viewBox="0 0 10 10"')
    expect(w.changes).toHaveLength(1)
    expect(w.changes[0]).toMatchObject({ assetId: '1', sizeDelta: stored.length - SVG_RAW.length })
    expect(w.changes[0]!.contentHash).toMatch(/^[0-9a-f]{64}$/)
    // the unsafe one is left exactly as it was
    expect(w.stored.get('p1:media/original/b.svg')!.data.toString()).toContain('<g></svg>')
  })

  it('finds an SVG master by its content type, whatever its extension is spelled', async () => {
    const w = world({ 'p1:media/original/a.SVG': { data: Buffer.from(SVG_RAW), contentType: 'image/svg+xml' } }, [asset('1', 'media/original/a.SVG', { content_type: 'image/svg+xml' })])
    const report = await runMetadataSweep({ store: w.store, cdn: w.cdn, siteUrl: 'https://s.example' })
    expect(report.svgNeedingClean).toBe(1)
  })

  it('leaves a missing or damaged file alone and reports it; one project only; variants only when asked', async () => {
    const dirty = await webpWithMetadata()
    const w = world({
      'p1:media/original/a.webp': { data: Buffer.from('RIFFxxxxWEBP-damaged'), contentType: 'image/webp' },
      'p2:media/original/b.webp': { data: dirty, contentType: 'image/webp' },
      'p2:media/thumb/b.webp': { data: dirty, contentType: 'image/webp' },
    }, [asset('1', 'media/original/a.webp'), asset('2', 'media/original/b.webp', { project_id: 'p2', variants: { thumb: { path: 'media/thumb/b.webp' } } }), asset('3', 'media/original/missing.webp')])

    const all = await runMetadataSweep({ store: w.store, cdn: w.cdn, siteUrl: 'https://s.example' })
    expect(all.errors.map(e => e.reason)).toEqual(expect.arrayContaining(['not a well-formed WebP', 'not found in storage']))
    expect(all.webpWithMetadata).toBe(1)

    const one = await runMetadataSweep({ store: w.store, cdn: w.cdn, siteUrl: 'https://s.example', projectId: 'p2' })
    expect(one.assetsScanned).toBe(1)
    expect(one.filesScanned).toBe(1)

    const withVariants = await runMetadataSweep({ store: w.store, cdn: w.cdn, siteUrl: 'https://s.example', projectId: 'p2', includeVariants: true })
    expect(withVariants.filesScanned).toBe(2)
    expect(withVariants.urls).toEqual(['https://s.example/api/cdn/v1/p2/media/original/b.webp', 'https://s.example/api/cdn/v1/p2/media/thumb/b.webp'])
  })

  it('prints the purge list as one URL per line and says how many 30-URL calls it takes', async () => {
    const report = { mode: 'apply', assetsScanned: 0, filesScanned: 0, webpWithMetadata: 0, webpWithGps: 0, svgNeedingClean: 0, svgUnsafe: [], errors: [], filesRewritten: 0, bytesFreed: 0, urls: Array.from({ length: 61 }, (_, i) => `https://s.example/api/cdn/v1/p/media/original/${i}.webp`) } as const
    expect(purgeList(report as never).split('\n').filter(Boolean)).toHaveLength(61)
    expect(purgeList(report as never).endsWith('\n')).toBe(true)
    expect(formatSweepReport(report as never)).toContain('61 URLs = 3 "purge by URL" calls of at most 30')
    expect(purgeList({ ...report, urls: [] } as never)).toBe('')
  })
})

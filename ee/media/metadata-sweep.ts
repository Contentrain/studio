/**
 * Sweep over stored media: take EXIF/XMP out of WebP files that still carry it (assets uploaded before #384 kept the
 * input's metadata in the public master) and re-sanitise stored SVGs (the library stored them as sent before #393).
 *
 * Lossless and in place: a WebP is rewritten by dropping its metadata chunks (`webp-metadata.ts`), pixels untouched;
 * an SVG goes through the same allow-list as a new upload. The storage path, and so every URL, stays the same.
 *
 * A dry run only reads and reports. An apply run verifies each rewritten WebP decodes to the very same pixels before it
 * replaces the object, then fixes the asset's `size_bytes` and the workspace storage counter by the difference.
 * Idempotent: a second run finds nothing to do.
 *
 * LICENSE: Proprietary — Contentrain Enterprise Edition
 */

import { createHash } from 'node:crypto'
import type { CDNProvider } from '../../server/providers/cdn'
import { sanitizeSvg } from '../../server/utils/svg-sanitize'
import { loadSharp } from './lazy-sharp'
import { inspectWebp, stripWebpMetadata } from './webp-metadata'

export interface SweepAsset {
  id: string
  project_id: string
  workspace_id: string
  content_type: string
  original_path: string
  variants: Record<string, { path: string }> | null
}

export interface SweepChange {
  assetId: string
  workspaceId: string
  /** New total − old total, in bytes (negative when the file shrank). */
  sizeDelta: number
  /** Set for an SVG: the content hash of the stored bytes changed with them. */
  contentHash?: string
}

export interface SweepStore {
  /** Assets with `id > afterId`, ordered by id, at most `limit`; `projectId` narrows to one project. */
  listAssets: (afterId: string | null, limit: number, projectId?: string) => Promise<SweepAsset[]>
  /** Record one applied rewrite: `size_bytes` (and `content_hash` for an SVG) on the row, and the workspace counter. */
  applyChange: (change: SweepChange) => Promise<void>
}

export interface SweepOptions {
  store: SweepStore
  cdn: CDNProvider
  /** Public site/CDN origin the delivery URLs are built from, e.g. `https://studio.contentrain.io` (no trailing slash). */
  siteUrl: string
  /** Default true: read and report only. */
  dryRun?: boolean
  projectId?: string
  /** Also look at variant files (they are cut by sharp without metadata, so this is a verification pass). */
  includeVariants?: boolean
  pageSize?: number
  onProgress?: (line: string) => void
}

export interface SweepReport {
  mode: 'dry-run' | 'apply'
  assetsScanned: number
  filesScanned: number
  /** WebP files with an EXIF and/or XMP chunk. */
  webpWithMetadata: number
  /** …of which the EXIF carries a GPS position. */
  webpWithGps: number
  /** Stored SVG files whose cleaned form differs from what is stored. */
  svgNeedingClean: number
  /** Stored SVG files the allow-list could not make well-formed (left untouched, need a person). */
  svgUnsafe: Array<{ assetId: string, path: string, reason: string }>
  /** Files that could not be read or verified (left untouched). */
  errors: Array<{ assetId: string, path: string, reason: string }>
  filesRewritten: number
  bytesFreed: number
  /** Public delivery URL of every file rewritten (apply) or that would be (dry run): the CDN-cache purge list. */
  urls: string[]
}

const PURGE_BATCH = 30

/** The report's human-readable summary, including the plain URL list split into purge-sized batches. */
export function formatSweepReport(report: SweepReport): string {
  const lines = [
    `mode: ${report.mode}`,
    `assets scanned: ${report.assetsScanned}, files scanned: ${report.filesScanned}`,
    `WebP with EXIF/XMP: ${report.webpWithMetadata} (with a GPS position: ${report.webpWithGps})`,
    `SVG needing a clean: ${report.svgNeedingClean}`,
    `SVG that could not be made safe (untouched): ${report.svgUnsafe.length}`,
    `errors (untouched): ${report.errors.length}`,
    `files ${report.mode === 'apply' ? 'rewritten' : 'that would be rewritten'}: ${report.mode === 'apply' ? report.filesRewritten : report.urls.length}`,
    `bytes ${report.mode === 'apply' ? 'freed' : 'that would be freed'}: ${report.bytesFreed}`,
  ]
  for (const row of report.svgUnsafe) lines.push(`  svg-unsafe ${row.assetId} ${row.path}: ${row.reason}`)
  for (const row of report.errors) lines.push(`  error ${row.assetId} ${row.path}: ${row.reason}`)
  if (report.urls.length) {
    const batches = Math.ceil(report.urls.length / PURGE_BATCH)
    lines.push('', `purge list: ${report.urls.length} URLs = ${batches} "purge by URL" call${batches === 1 ? '' : 's'} of at most ${PURGE_BATCH} (split -l ${PURGE_BATCH} <file>)`)
  }
  return lines.join('\n')
}

/** One URL per line, nothing else: ready to feed a "purge by URL" call (30 per call). */
export function purgeList(report: SweepReport): string {
  return report.urls.length ? `${report.urls.join('\n')}\n` : ''
}

/**
 * Whether two WebP files decode to the same pixels. Each is decoded on its own and reduced to a digest before the next one
 * is decoded, so only one raw frame buffer (a large animated WebP is hundreds of MB) is held at a time.
 */
async function samePixels(before: Buffer, after: Buffer): Promise<boolean> {
  const sharp = await loadSharp()
  const digest = async (buf: Buffer) => {
    const { data, info } = await sharp(buf, { animated: true }).raw().toBuffer({ resolveWithObject: true })
    return `${info.width}x${info.height}x${info.channels}:${createHash('sha256').update(data).digest('hex')}`
  }
  const first = await digest(before)
  return first === await digest(after)
}

export async function runMetadataSweep(options: SweepOptions): Promise<SweepReport> {
  const { store, cdn, siteUrl } = options
  const dryRun = options.dryRun ?? true
  const pageSize = options.pageSize ?? 200
  const base = siteUrl.replace(/\/+$/, '')
  const report: SweepReport = {
    mode: dryRun ? 'dry-run' : 'apply',
    assetsScanned: 0,
    filesScanned: 0,
    webpWithMetadata: 0,
    webpWithGps: 0,
    svgNeedingClean: 0,
    svgUnsafe: [],
    errors: [],
    filesRewritten: 0,
    bytesFreed: 0,
    urls: [],
  }

  let after: string | null = null
  for (;;) {
    const assets = await store.listAssets(after, pageSize, options.projectId)
    if (assets.length === 0) break
    for (const asset of assets) {
      after = asset.id
      report.assetsScanned++
      const paths = [asset.original_path, ...(options.includeVariants ? Object.values(asset.variants ?? {}).map(v => v.path) : [])]
      let sizeDelta = 0
      const rewritten: string[] = []
      let contentHash: string | undefined
      for (const path of paths) {
        // An SVG master is named after the uploaded file's own extension (`.SVG` too); everything else of interest is `.webp`.
        const isSvg = path === asset.original_path && (asset.content_type === 'image/svg+xml' || /\.svg$/i.test(path))
        const isWebp = !isSvg && /\.webp$/i.test(path)
        if (!isSvg && !isWebp) continue
        report.filesScanned++
        try {
          const object = await cdn.getObject(asset.project_id, path)
          if (!object || 'notModified' in object) {
            report.errors.push({ assetId: asset.id, path, reason: 'not found in storage' })
            continue
          }
          let next: Buffer | null = null
          if (isWebp) {
            const found = inspectWebp(object.data)
            if (!found) {
              report.errors.push({ assetId: asset.id, path, reason: 'not a well-formed WebP' })
              continue
            }
            if (!found.exif && !found.xmp) continue
            report.webpWithMetadata++
            if (found.gps) report.webpWithGps++
            const stripped = stripWebpMetadata(object.data)
            if (!stripped?.changed) continue
            if (!dryRun && !await samePixels(object.data, stripped.buffer)) {
              report.errors.push({ assetId: asset.id, path, reason: 'pixels differ after removal; left untouched' })
              continue
            }
            next = stripped.buffer
          }
          else {
            const clean = sanitizeSvg(object.data)
            if (!clean.ok || clean.bytes.length === 0) {
              report.svgUnsafe.push({ assetId: asset.id, path, reason: clean.ok ? 'empty' : clean.reason })
              continue
            }
            if (clean.bytes.equals(object.data)) continue
            report.svgNeedingClean++
            next = clean.bytes
            if (path === asset.original_path) contentHash = createHash('sha256').update(next).digest('hex')
          }

          const delta = next.length - object.data.length
          if (!dryRun) await cdn.putObject(asset.project_id, path, next, object.contentType)
          sizeDelta += delta
          rewritten.push(path)
          report.bytesFreed -= delta
          report.filesRewritten += dryRun ? 0 : 1
          report.urls.push(`${base}/api/cdn/v1/${asset.project_id}/${path}`)
        }
        catch (error) {
          report.errors.push({ assetId: asset.id, path, reason: error instanceof Error ? error.message : String(error) })
        }
      }
      if (!dryRun && (sizeDelta !== 0 || contentHash)) {
        try {
          await store.applyChange({ assetId: asset.id, workspaceId: asset.workspace_id, sizeDelta, ...(contentHash ? { contentHash } : {}) })
        }
        catch (error) {
          report.errors.push({ assetId: asset.id, path: asset.original_path, reason: `files rewritten (${rewritten.join(', ')}; sizeDelta ${sizeDelta}) but the row/counter update failed: ${error instanceof Error ? error.message : String(error)}` })
        }
      }
    }
    options.onProgress?.(`scanned ${report.assetsScanned} assets`)
  }
  return report
}

/**
 * Lossless EXIF/XMP removal for a WebP file.
 *
 * A WebP is a RIFF container: `RIFF <size> WEBP` followed by chunks (`VP8X`, `ICCP`, `ANIM`, `ANMF`, `ALPH`, `VP8 `,
 * `VP8L`, `EXIF`, `XMP `). Camera metadata lives in the top-level `EXIF` and `XMP ` chunks, so it is removed by
 * dropping those chunks, clearing their two flags in `VP8X` and rewriting the RIFF size. Every other chunk (the pixel
 * data, the animation frames, the colour profile) is copied byte for byte: nothing is decoded or re-encoded, so there
 * is no quality loss and the pixels are identical.
 *
 * The colour profile (`ICCP`) is kept on purpose: it is not personal data and dropping it changes how colours render.
 *
 * LICENSE: Proprietary — Contentrain Enterprise Edition
 */

const VP8X_FLAG_EXIF = 0x08
const VP8X_FLAG_XMP = 0x04

export interface WebpMetadata {
  /** A top-level `EXIF` chunk is present. */
  exif: boolean
  /** The EXIF block points at a GPS IFD (a position). */
  gps: boolean
  /** A top-level `XMP ` chunk is present. */
  xmp: boolean
}

interface Chunk { id: string, start: number, end: number, dataStart: number, size: number }

function readChunks(buf: Buffer): Chunk[] | null {
  if (buf.length < 12 || buf.toString('latin1', 0, 4) !== 'RIFF' || buf.toString('latin1', 8, 12) !== 'WEBP') return null
  const riffEnd = Math.min(buf.length, 8 + buf.readUInt32LE(4))
  const chunks: Chunk[] = []
  let pos = 12
  while (pos + 8 <= riffEnd) {
    const size = buf.readUInt32LE(pos + 4)
    const dataStart = pos + 8
    const end = dataStart + size + (size % 2)
    // A chunk running past the container is a damaged file: refuse to touch it. (Only the final pad byte may be absent.)
    if (dataStart + size > riffEnd) return null
    chunks.push({ id: buf.toString('latin1', pos, pos + 4), start: pos, end: Math.min(end, riffEnd), dataStart, size })
    pos = end
  }
  return chunks
}

/** Whether an EXIF payload (TIFF, optionally behind an `Exif\0\0` prefix) carries a GPS IFD pointer (tag 0x8825). */
export function exifHasGps(exif: Buffer): boolean {
  const base = exif.toString('latin1', 0, 6) === 'Exif\0\0' ? 6 : 0
  if (exif.length < base + 8) return false
  const order = exif.toString('latin1', base, base + 2)
  const le = order === 'II'
  if (!le && order !== 'MM') return false
  const u16 = (o: number) => (le ? exif.readUInt16LE(o) : exif.readUInt16BE(o))
  const u32 = (o: number) => (le ? exif.readUInt32LE(o) : exif.readUInt32BE(o))
  if (u16(base + 2) !== 42) return false
  const ifd = base + u32(base + 4)
  if (ifd + 2 > exif.length) return false
  const count = u16(ifd)
  for (let i = 0; i < count; i++) {
    const entry = ifd + 2 + i * 12
    if (entry + 12 > exif.length) return false
    if (u16(entry) === 0x8825) return true
  }
  return false
}

/** What a WebP carries; null when the bytes are not a well-formed WebP. */
export function inspectWebp(buf: Buffer): WebpMetadata | null {
  const chunks = readChunks(buf)
  if (!chunks) return null
  const exifChunk = chunks.find(c => c.id === 'EXIF')
  return {
    exif: exifChunk !== undefined,
    gps: exifChunk ? exifHasGps(buf.subarray(exifChunk.dataStart, exifChunk.dataStart + exifChunk.size)) : false,
    xmp: chunks.some(c => c.id === 'XMP '),
  }
}

/**
 * The same WebP without its EXIF and XMP chunks. `changed: false` (and the input returned as-is) when there was nothing
 * to remove; `null` when the bytes are not a well-formed WebP.
 */
export function stripWebpMetadata(buf: Buffer): { buffer: Buffer, changed: boolean } | null {
  const chunks = readChunks(buf)
  if (!chunks) return null
  if (!chunks.some(c => c.id === 'EXIF' || c.id === 'XMP ')) return { buffer: buf, changed: false }

  const kept: Buffer[] = []
  for (const chunk of chunks) {
    if (chunk.id === 'EXIF' || chunk.id === 'XMP ') continue
    const copy = Buffer.from(buf.subarray(chunk.start, chunk.end))
    if (chunk.id === 'VP8X') copy[8] = copy[8]! & ~(VP8X_FLAG_EXIF | VP8X_FLAG_XMP)
    // A chunk whose pad byte was missing at the very end of the file: restore it so the RIFF stays even-aligned.
    kept.push(copy.length % 2 === 1 ? Buffer.concat([copy, Buffer.alloc(1)]) : copy)
  }
  const header = Buffer.from(buf.subarray(0, 12))
  const body = Buffer.concat(kept)
  header.writeUInt32LE(4 + body.length, 4)
  return { buffer: Buffer.concat([header, body]), changed: true }
}

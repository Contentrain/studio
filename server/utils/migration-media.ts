/**
 * A migration's media, as Migrate committed it — `.contentrain/migrate/media.json`
 * — and what moving it into Studio Media would take.
 *
 * Migrate localizes a site's images into the repository (`public/media/…`)
 * and writes this manifest beside the handoff: every asset with its repository
 * path, the exact bytes and hash of the file it wrote, and every place content
 * refers to it (a file and an RFC 6901 pointer). Studio reads the files from
 * Git, not the old WordPress URLs — the site may already be gone.
 *
 * The manifest's shape is Migrate's (`packages/media/src/localize.ts`,
 * `MediaManifest`); this is Studio's reading of it. Required fields are
 * checked hard — an asset without its path, size, hash, type or refs cannot be
 * moved or rewritten safely — while unknown fields are ignored so Migrate can
 * add to it without breaking Studio.
 */

import type { GitProvider, TreeEntry } from '~~/server/providers/git'
import { CONTENTRAIN_BRANCH } from '@contentrain/types'
import type { Plan } from './license'
import { getEffectiveLimit } from './overage'

export const MEDIA_MANIFEST_PATH = '.contentrain/migrate/media.json'
/** Well past any real manifest (one row per asset); a runaway file is refused before it is parsed. */
export const MEDIA_MANIFEST_MAX_BYTES = 10 * 1024 * 1024

export type MediaRefMatch = 'exact' | 'contains' | 'relation'

export interface MigrationMediaRef {
  /** Project-relative path of the content file. */
  file: string
  /** RFC 6901 pointer to the string value (`""` for a markdown file's whole text). */
  pointer: string
  /** `exact`: the value is the local URL; `contains`: the URL is inside the value; `relation`: the value is the asset's id. */
  match: MediaRefMatch
}

export interface MigrationMediaAsset {
  id: string
  /** `font` assets stay in the repository — the site's font provider refers to them, not content. */
  role: 'media' | 'font'
  repoPath: string
  /** What content currently says (`/media/…`) — the string a rewrite looks for. */
  localUrl?: string
  sourceUrl?: string
  sha256: string
  bytes: number
  mime: string
  width?: number
  height?: number
  alt?: string
  refs: MigrationMediaRef[]
}

export interface MigrationMediaManifest {
  version: 1
  origin?: string
  assets: MigrationMediaAsset[]
}

const MATCHES = new Set<MediaRefMatch>(['exact', 'contains', 'relation'])
const SHA256 = /^[a-f0-9]{64}$/

function safeRepoPath(path: string): boolean {
  if (!path || path.startsWith('/') || path.includes('\\') || path.includes('\0')) return false
  return path.split('/').every(part => part !== '' && part !== '.' && part !== '..')
}

/**
 * Parse the manifest; throws a 422 naming the first problem. Media assets must
 * live under `public/media/` — the only place Migrate writes them, and the
 * only place an import will read from.
 */
export function parseMigrationMediaManifest(raw: unknown): MigrationMediaManifest {
  const fail = (detail: string): never => {
    throw createError({ statusCode: 422, message: errorMessage('migration.media_manifest_invalid', { detail }) })
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail('not an object')
  const doc = raw as Record<string, unknown>
  if (doc.version !== 1) return fail(`unsupported version ${JSON.stringify(doc.version)}`)
  if (!Array.isArray(doc.assets)) return fail('assets is not a list')

  const seen = new Set<string>()
  const assets = doc.assets.map((value, i): MigrationMediaAsset => {
    const at = `assets[${i}]`
    if (!value || typeof value !== 'object') return fail(`${at} is not an object`)
    const a = value as Record<string, unknown>
    const role = a.role === undefined ? 'media' : a.role
    if (role !== 'media' && role !== 'font') return fail(`${at}.role ${JSON.stringify(a.role)}`)
    if (typeof a.repoPath !== 'string' || !safeRepoPath(a.repoPath)) return fail(`${at}.repoPath`)
    if (role === 'media' && !a.repoPath.startsWith('public/media/')) return fail(`${at}.repoPath is outside public/media/`)
    if (seen.has(a.repoPath)) return fail(`${at}.repoPath is listed twice`)
    seen.add(a.repoPath)
    if (typeof a.sha256 !== 'string' || !SHA256.test(a.sha256)) return fail(`${at}.sha256`)
    if (typeof a.bytes !== 'number' || !Number.isInteger(a.bytes) || a.bytes < 0) return fail(`${at}.bytes`)
    if (typeof a.mime !== 'string' || !a.mime) return fail(`${at}.mime`)
    if (!Array.isArray(a.refs)) return fail(`${at}.refs`)
    const refs = a.refs.map((r, j): MigrationMediaRef => {
      const ref = r as Record<string, unknown> | null
      if (!ref || typeof ref.file !== 'string' || !safeRepoPath(ref.file)) return fail(`${at}.refs[${j}].file`)
      if (typeof ref.pointer !== 'string' || (ref.pointer !== '' && !ref.pointer.startsWith('/'))) return fail(`${at}.refs[${j}].pointer`)
      if (typeof ref.match !== 'string' || !MATCHES.has(ref.match as MediaRefMatch)) return fail(`${at}.refs[${j}].match`)
      return { file: ref.file, pointer: ref.pointer, match: ref.match as MediaRefMatch }
    })
    const dim = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined)
    return {
      id: typeof a.id === 'string' && a.id ? a.id : a.sha256.slice(0, 16),
      role,
      repoPath: a.repoPath,
      ...(typeof a.localUrl === 'string' ? { localUrl: a.localUrl } : {}),
      ...(typeof a.sourceUrl === 'string' ? { sourceUrl: a.sourceUrl } : {}),
      sha256: a.sha256,
      bytes: a.bytes,
      mime: a.mime,
      ...(dim(a.width) ? { width: dim(a.width) } : {}),
      ...(dim(a.height) ? { height: dim(a.height) } : {}),
      ...(typeof a.alt === 'string' ? { alt: a.alt.slice(0, 500) } : {}),
      refs,
    }
  })

  return { version: 1, ...(typeof doc.origin === 'string' ? { origin: doc.origin } : {}), assets }
}

/** The manifest from the project's content branch (or default branch), or null when Migrate wrote none. */
export async function readMigrationMediaManifest(git: GitProvider, contentRoot: string, defaultBranch: string): Promise<{ manifest: MigrationMediaManifest, ref: string, path: string } | null> {
  const paths = [...new Set([contentRoot ? `${contentRoot}/${MEDIA_MANIFEST_PATH}` : MEDIA_MANIFEST_PATH, MEDIA_MANIFEST_PATH])]
  for (const ref of [...new Set([CONTENTRAIN_BRANCH, defaultBranch || 'main'])]) {
    for (const path of paths) {
      let text: string
      try {
        text = await git.readFile(path, ref)
      }
      catch {
        continue
      }
      if (!text) continue
      if (Buffer.byteLength(text, 'utf8') > MEDIA_MANIFEST_MAX_BYTES)
        throw createError({ statusCode: 413, message: errorMessage('migration.media_manifest_too_large') })
      let raw: unknown
      try {
        raw = JSON.parse(text)
      }
      catch {
        throw createError({ statusCode: 422, message: errorMessage('migration.media_manifest_invalid', { detail: 'not JSON' }) })
      }
      return { manifest: parseMigrationMediaManifest(raw), ref, path }
    }
  }
  return null
}

// ─── Preflight ───

export interface MigrationMediaPreflight {
  /** Media assets to move (fonts stay in the repository and are not counted). */
  count: number
  totalBytes: number
  /** Assets over the plan's per-file cap — they would fail on import. */
  overSize: Array<{ repoPath: string, bytes: number }>
  /** Assets the manifest lists but the branch does not hold, or holds with another size. */
  missing: Array<{ repoPath: string, reason: 'not_in_repo' | 'size_mismatch' }>
  /** Font assets, left where they are. */
  fontsKept: number
  /** How many content places refer to the assets — what a later rewrite touches. */
  refs: number
  limits: {
    maxFileBytes: number | null
    storageBytes: number | null
  }
  storage: {
    usedBytes: number
    /** Null when the plan sets no ceiling. */
    remainingBytes: number | null
  }
  /** Everything that can be moved fits in the remaining storage (dedupe can only lower the need). */
  fits: boolean
  /** The lowest plan that would take all of it, when this one does not — for the upgrade prompt. */
  upgrade: { plan: string, params: Record<string, string | number> } | null
}

/** A limit as bytes; null when the plan sets none (0, unlimited, or not a number). */
function limitBytes(value: number, unit: number): number | null {
  return value > 0 && Number.isFinite(value) ? value * unit : null
}

const GB = 1024 * 1024 * 1024
const MB = 1024 * 1024
const SOLD_PLANS = ['starter', 'pro', 'enterprise'] as const

export function planMigrationMediaPreflight(input: {
  manifest: MigrationMediaManifest
  tree: TreeEntry[]
  plan: Plan
  usedBytes: number
  overageSettings?: Record<string, boolean>
}): MigrationMediaPreflight {
  const blobs = new Map(input.tree.filter(e => e.type === 'blob').map(e => [e.path, e]))
  const media = input.manifest.assets.filter(a => a.role === 'media')

  const maxFileBytes = limitBytes(getPlanLimit(input.plan, 'media.max_file_size_mb'), MB)
  const baseStorage = getPlanLimit(input.plan, 'media.storage_gb') * GB
  const storageBytes = limitBytes(getEffectiveLimit(baseStorage, 'media.storage_gb', input.overageSettings ?? {}) / GB, GB)

  const missing: MigrationMediaPreflight['missing'] = []
  const overSize: MigrationMediaPreflight['overSize'] = []
  let movableBytes = 0
  let largest = 0
  for (const asset of media) {
    const blob = blobs.get(asset.repoPath)
    if (!blob) {
      missing.push({ repoPath: asset.repoPath, reason: 'not_in_repo' })
      continue
    }
    if (typeof blob.size === 'number' && blob.size !== asset.bytes) {
      missing.push({ repoPath: asset.repoPath, reason: 'size_mismatch' })
      continue
    }
    largest = Math.max(largest, asset.bytes)
    if (maxFileBytes !== null && asset.bytes > maxFileBytes) {
      overSize.push({ repoPath: asset.repoPath, bytes: asset.bytes })
      continue
    }
    movableBytes += asset.bytes
  }

  const usedBytes = Math.max(0, input.usedBytes)
  const remainingBytes = storageBytes === null ? null : Math.max(0, storageBytes - usedBytes)
  const fits = remainingBytes === null || movableBytes <= remainingBytes
  const totalBytes = media.reduce((sum, a) => sum + a.bytes, 0)

  let upgrade: MigrationMediaPreflight['upgrade'] = null
  if (!fits || overSize.length > 0) {
    const current = SOLD_PLANS.indexOf(input.plan as typeof SOLD_PLANS[number])
    const need = usedBytes + movableBytes + overSize.reduce((sum, a) => sum + a.bytes, 0)
    for (const candidate of SOLD_PLANS.slice(current + 1)) {
      const file = limitBytes(getPlanLimitForPlan(candidate, 'media.max_file_size_mb'), MB)
      const storage = limitBytes(getPlanLimitForPlan(candidate, 'media.storage_gb'), GB)
      if ((file === null || largest <= file) && (storage === null || need <= storage)) {
        upgrade = { plan: candidate, params: getUpgradeParams(input.plan, candidate) }
        break
      }
    }
  }

  return {
    count: media.length,
    totalBytes,
    overSize,
    missing,
    fontsKept: input.manifest.assets.length - media.length,
    refs: media.reduce((sum, a) => sum + a.refs.length, 0),
    limits: { maxFileBytes, storageBytes },
    storage: { usedBytes, remainingBytes },
    fits,
    upgrade,
  }
}

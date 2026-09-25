/**
 * Point a migrated site at its media in Studio — the last step after the
 * import (`migration-media-import.ts`).
 *
 * Every reference Migrate recorded (`media.json` refs: a content file and an
 * RFC 6901 pointer) is rewritten from the local URL (`/media/…`) to the
 * asset's Studio delivery URL, by walking to that value — never a text
 * replace over the file:
 *
 * - `exact`    the value is the local URL → the delivery URL;
 * - `contains` the local URL is inside the value (rich-text HTML, `srcset`,
 *              Gutenberg's comment JSON, possibly written `\/`-escaped) →
 *              each occurrence, on its own boundaries, in that value only;
 * - `relation` the value is the media entry's id → nothing to rewrite.
 *
 * A value that no longer holds what the manifest says (edited since the
 * migration) is left alone and reported as drifted. `studio.json` at the
 * project root gets `{ baseUrl, projectId }` — the starter builds its image
 * `remotePatterns` from it, so Studio URLs are optimized. The local files
 * under `public/media/` are deleted only when asked AND nothing can still
 * point at them: every media asset imported, no drift, and no local URL left
 * in any referencing file after the rewrite. Otherwise the site keeps building
 * from the files it has.
 */

import type { FileChange } from '@contentrain/types'
import { canonicalStringify } from '@contentrain/types'
import type { MigrationMediaManifest } from './migration-media'
import { projectPath } from './migration-media'

export const STUDIO_BINDING_FILE = 'studio.json'

export interface MigrationMediaApplyInput {
  manifest: MigrationMediaManifest
  /** Project root the manifest's paths are relative to. */
  root: string
  /** repository path (as imported) → delivery URL, for every imported asset. */
  imported: ReadonlyMap<string, string>
  /** Reads a repository file at the write snapshot; null when absent. */
  read: (path: string) => Promise<string | null>
  /**
   * `baseUrl`: the Studio API origin (forms, comments). `mediaBaseUrl`: the project's FULL media delivery
   * base (`publicMediaBase`, e.g. `https://cdn.example/api/cdn/v1/<projectId>`), which the starter builds its
   * image `remotePatterns` from (`<its path>/media/**`); written only when it is not the default derived from
   * `baseUrl`, i.e. when media is served from a separate CDN host.
   */
  studio: { baseUrl: string, projectId: string, mediaBaseUrl?: string }
  deleteLocal: boolean
  /**
   * Every file at the write snapshot (repository paths, with sizes). Before deleting, every text file in the
   * project is searched for the local URLs — the site's own code, styles and config refer to media too
   * (`<img src="/media/…">` in a component, `url(/media/…)` in CSS, `_headers`), and the manifest lists
   * content references only. Without it nothing is deleted.
   */
  listFiles?: () => Promise<Array<{ path: string, size?: number }>>
}

/** Files a site can mention a media URL in. Binary files and the migration's own records are not read. */
const TEXT_FILE = /\.(?:astro|[cm]?[jt]sx?|vue|svelte|css|scss|sass|less|html?|mdx?|json|ya?ml|toml|txt|xml|svg|webmanifest)$|(?:^|\/)_(?:headers|redirects)$/i
const SKIP_DIR = /(?:^|\/)(?:node_modules|dist|\.astro|\.git|\.contentrain\/migrate|\.contentrain\/client)\//
/** Past this many files, or files this large, the project is not searched and nothing is deleted. */
export const DELETE_SCAN_MAX_FILES = 1500
const DELETE_SCAN_MAX_BYTES = 2 * 1024 * 1024

export interface MigrationMediaApplyCounts {
  filesChanged: number
  rewritten: number
  alreadyRewritten: number
  relations: number
  drifted: Array<{ file: string, pointer: string, repoPath: string }>
  notImported: string[]
  /** Local URLs still found in referencing files after the rewrite. */
  remaining: Array<{ file: string, url: string }>
  studioBinding: 'written' | 'unchanged'
  deleted: number
  /** Why local files were kept, when deletion was asked for. */
  keptBecause: 'not_requested' | 'not_all_imported' | 'drifted' | 'remaining_refs' | 'too_large_to_verify' | null
  /** Files the deletion would remove (only when it goes ahead). */
  deletedPaths: string[]
}

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** The URL on its own boundaries: not part of a longer path or file name. */
function occurrence(url: string): RegExp {
  return new RegExp(`(?<![\\w.\\\\/-])${escapeRegExp(url)}(?![\\w.-])`, 'g')
}

/** Replace a local URL in text, in its plain and its `\/`-escaped spelling. */
function replaceIn(text: string, from: string, to: string): { text: string, count: number } {
  let count = 0
  let out = text.replace(occurrence(from), () => {
    count++
    return to
  })
  const escapedFrom = from.replace(/\//g, '\\/')
  if (escapedFrom !== from) {
    out = out.replace(new RegExp(`(?<![\\w.-])${escapeRegExp(escapedFrom)}(?![\\w.-])`, 'g'), () => {
      count++
      return to.replace(/\//g, '\\/')
    })
  }
  return { text: out, count }
}

const hasOccurrence = (text: string, url: string): boolean =>
  occurrence(url).test(text) || text.includes(url.replace(/\//g, '\\/'))

function decodePointer(pointer: string): string[] {
  if (pointer === '') return []
  return pointer.slice(1).split('/').map(p => p.replace(/~1/g, '/').replace(/~0/g, '~'))
}

function getAt(doc: unknown, tokens: string[]): { parent: Record<string, unknown> | unknown[], key: string } | null {
  let node = doc
  for (let i = 0; i < tokens.length - 1; i++) {
    if (!node || typeof node !== 'object') return null
    node = (node as Record<string, unknown>)[tokens[i]!]
  }
  if (!node || typeof node !== 'object' || tokens.length === 0) return null
  return { parent: node as Record<string, unknown>, key: tokens.at(-1)! }
}

interface OpenFile { path: string, kind: 'json' | 'text', original: string, doc: unknown, text: string, dirty: boolean }

export async function planMigrationMediaApply(input: MigrationMediaApplyInput): Promise<{ changes: FileChange[], counts: MigrationMediaApplyCounts }> {
  const counts: MigrationMediaApplyCounts = {
    filesChanged: 0,
    rewritten: 0,
    alreadyRewritten: 0,
    relations: 0,
    drifted: [],
    notImported: [],
    remaining: [],
    studioBinding: 'unchanged',
    deleted: 0,
    keptBecause: null,
    deletedPaths: [],
  }
  const files = new Map<string, OpenFile | null>()
  const open = async (file: string): Promise<OpenFile | null> => {
    const path = projectPath(input.root, file)
    if (files.has(path)) return files.get(path)!
    const original = await input.read(path)
    let opened: OpenFile | null = null
    if (original !== null) {
      if (path.endsWith('.json')) {
        try {
          opened = { path, kind: 'json', original, doc: JSON.parse(original), text: original, dirty: false }
        }
        catch {
          opened = null
        }
      }
      else {
        opened = { path, kind: 'text', original, doc: null, text: original, dirty: false }
      }
    }
    files.set(path, opened)
    return opened
  }

  const media = input.manifest.assets.filter(a => a.role === 'media')
  const moved: Array<{ localUrl: string, deliveryUrl: string }> = []

  for (const asset of media) {
    const repoPath = projectPath(input.root, asset.repoPath)
    const deliveryUrl = input.imported.get(repoPath)
    if (!deliveryUrl) {
      counts.notImported.push(asset.repoPath)
      continue
    }
    const localUrl = asset.localUrl ?? `/${asset.repoPath.replace(/^public\//, '')}`
    moved.push({ localUrl, deliveryUrl })

    for (const ref of asset.refs) {
      if (ref.match === 'relation') {
        counts.relations++
        continue
      }
      const file = await open(ref.file)
      const drift = () => counts.drifted.push({ file: ref.file, pointer: ref.pointer, repoPath: asset.repoPath })
      if (!file) {
        drift()
        continue
      }

      // A markdown file (pointer "") is one text value.
      if (file.kind === 'text' || ref.pointer === '') {
        if (file.kind !== 'text') {
          drift()
          continue
        }
        const { text, count } = replaceIn(file.text, localUrl, deliveryUrl)
        if (count > 0) {
          file.text = text
          file.dirty = true
          counts.rewritten += count
        }
        else if (file.text.includes(deliveryUrl)) {
          counts.alreadyRewritten++
        }
        else {
          drift()
        }
        continue
      }

      const at = getAt(file.doc, decodePointer(ref.pointer))
      const value = at ? (at.parent as Record<string, unknown>)[at.key] : undefined
      if (!at || typeof value !== 'string') {
        drift()
        continue
      }
      if (ref.match === 'exact') {
        if (value === localUrl) {
          (at.parent as Record<string, unknown>)[at.key] = deliveryUrl
          file.dirty = true
          counts.rewritten++
        }
        else if (value === deliveryUrl) {
          counts.alreadyRewritten++
        }
        else {
          drift()
        }
        continue
      }
      const { text, count } = replaceIn(value, localUrl, deliveryUrl)
      if (count > 0) {
        (at.parent as Record<string, unknown>)[at.key] = text
        file.dirty = true
        counts.rewritten += count
      }
      else if (value.includes(deliveryUrl)) {
        counts.alreadyRewritten++
      }
      else {
        drift()
      }
    }
  }

  const changes: FileChange[] = []
  for (const file of files.values()) {
    if (!file) continue
    // Only a file something was rewritten in is written, and as canonical JSON (the writers' own format).
    const next = !file.dirty ? file.original : file.kind === 'json' ? canonicalStringify(file.doc) : file.text
    for (const { localUrl } of moved) {
      if (hasOccurrence(next, localUrl)) counts.remaining.push({ file: file.path, url: localUrl })
    }
    if (next !== file.original) changes.push({ path: file.path, content: next })
  }
  counts.filesChanged = changes.length

  const bindingPath = projectPath(input.root, STUDIO_BINDING_FILE)
  const baseUrl = input.studio.baseUrl.replace(/\/+$/, '')
  const mediaBaseUrl = input.studio.mediaBaseUrl?.replace(/\/+$/, '')
  // Written only when it differs from what the starter derives by default (`${baseUrl}/api/cdn/v1/${projectId}`).
  const derived = `${baseUrl}/api/cdn/v1/${input.studio.projectId}`
  const binding = canonicalStringify({
    baseUrl,
    ...(mediaBaseUrl && mediaBaseUrl !== derived ? { mediaBaseUrl } : {}),
    projectId: input.studio.projectId,
  })
  if ((await input.read(bindingPath)) !== binding) {
    changes.push({ path: bindingPath, content: binding })
    counts.studioBinding = 'written'
  }

  counts.keptBecause = !input.deleteLocal
    ? 'not_requested'
    : counts.notImported.length > 0
      ? 'not_all_imported'
      : counts.drifted.length > 0
        ? 'drifted'
        : counts.remaining.length > 0
          ? 'remaining_refs'
          : null
  if (counts.keptBecause === null)
    counts.keptBecause = await scanProjectForLocalUrls(input, files, moved.map(m => m.localUrl), counts)
  if (counts.keptBecause === null) {
    for (const asset of media) changes.push({ path: projectPath(input.root, asset.repoPath), content: null })
    counts.deleted = media.length
    counts.deletedPaths = media.map(a => projectPath(input.root, a.repoPath)).sort()
  }

  return { changes: changes.sort((a, b) => a.path.localeCompare(b.path)), counts }
}

/**
 * The last guard before deleting: no text file anywhere in the project still
 * names a local media URL. The referencing files were already checked after
 * their rewrite; this reads the rest at the same snapshot.
 */
async function scanProjectForLocalUrls(
  input: MigrationMediaApplyInput,
  opened: Map<string, unknown>,
  urls: string[],
  counts: MigrationMediaApplyCounts,
): Promise<MigrationMediaApplyCounts['keptBecause']> {
  if (!input.listFiles) return 'too_large_to_verify'
  const prefix = input.root ? `${input.root}/` : ''
  const candidates = (await input.listFiles()).filter(f =>
    f.path.startsWith(prefix)
    && !opened.has(f.path)
    && TEXT_FILE.test(f.path)
    && !SKIP_DIR.test(`/${f.path.slice(prefix.length)}`)
    && !f.path.slice(prefix.length).startsWith('public/media/'))
  if (candidates.length > DELETE_SCAN_MAX_FILES || candidates.some(f => (f.size ?? 0) > DELETE_SCAN_MAX_BYTES))
    return 'too_large_to_verify'
  for (const file of candidates) {
    const text = await input.read(file.path)
    if (text === null) continue
    for (const url of urls) {
      if (hasOccurrence(text, url)) counts.remaining.push({ file: file.path, url })
    }
  }
  return counts.remaining.length > 0 ? 'remaining_refs' : null
}

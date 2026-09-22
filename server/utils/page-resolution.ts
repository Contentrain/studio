import type { ModelDefinition } from '@contentrain/types'
import { pickLabel } from './relation-expand'

/**
 * Resolve a site page the editor links to back to the entry that renders it.
 *
 * Editors attach the live page they want changed and write a short order:
 * "delete this", "update its cover". The agent used to treat every attached
 * page as source material, so "delete this" started CREATING the article, a
 * cover change created a new one, the wrong article got deleted, and once the
 * agent said the site "does not match this project" and asked for a hand-made
 * table of 22 URL → slug pairs (#288).
 *
 * Studio does not know a project's public site address, so the page is matched
 * by its path against what the content brain holds: document slugs, and the
 * values of `slug`-typed fields in collections. A slug is the evidence — no
 * host check. The last path segment is tried first (`/guides/youtube` →
 * `youtube`), then the ones before it.
 */

export interface PageCandidate {
  model: string
  /** Collection entry id, or document slug. */
  entry: string
  title: string | null
  locales: string[]
}

export interface PageResolution {
  url: string
  /** `resolved`: exactly one entry; `ambiguous`: several; `none`: no entry has this slug. */
  status: 'resolved' | 'ambiguous' | 'none'
  candidates: PageCandidate[]
}

interface BrainLike {
  models: Map<string, ModelDefinition>
  content: Map<string, unknown>
}

const URL_PATTERN = /https?:\/\/[^\s<>"'`)\]]+/g
/** A path ending in a file extension is an asset (image, pdf, …), not a page. */
const FILE_EXTENSION = /\.[a-z0-9]{2,5}$/i
const MAX_PAGES = 5
const MAX_CANDIDATES = 5

/** Page URLs the editor gave this turn: attached links, then URLs pasted in the text. */
export function extractPageUrls(message: string, attachedFilenames: string[]): string[] {
  const urls: string[] = []
  for (const name of attachedFilenames) {
    if (/^https?:\/\//i.test(name)) urls.push(name)
  }
  for (const match of message.matchAll(URL_PATTERN)) urls.push(match[0].replace(/[.,;:!?]+$/, ''))

  const seen = new Set<string>()
  const pages: string[] = []
  for (const url of urls) {
    const segments = pathSegments(url)
    if (!segments || segments.length === 0) continue
    if (FILE_EXTENSION.test(segments.at(-1)!)) continue
    if (seen.has(url)) continue
    seen.add(url)
    pages.push(url)
    if (pages.length === MAX_PAGES) break
  }
  return pages
}

export function resolvePageUrl(url: string, brain: BrainLike): PageResolution {
  const segments = pathSegments(url) ?? []
  const index = slugIndex(brain)
  for (const segment of segments.toReversed()) {
    const hits = index.get(segment)
    if (!hits || hits.size === 0) continue
    const candidates = [...hits.values()].slice(0, MAX_CANDIDATES)
    return { url, status: candidates.length === 1 ? 'resolved' : 'ambiguous', candidates }
  }
  return { url, status: 'none', candidates: [] }
}

function pathSegments(url: string): string[] | null {
  try {
    return new URL(url).pathname
      .split('/')
      .filter(Boolean)
      .map(segment => safeDecode(segment).toLowerCase())
  }
  catch {
    return null
  }
}

function safeDecode(segment: string): string {
  try {
    return decodeURIComponent(segment)
  }
  catch {
    return segment
  }
}

/** slug → entries carrying it, one candidate per model+entry across locales. */
function slugIndex(brain: BrainLike): Map<string, Map<string, PageCandidate>> {
  const index = new Map<string, Map<string, PageCandidate>>()
  const add = (slug: unknown, model: string, entry: string, title: string | null, locale: string) => {
    if (typeof slug !== 'string' || !slug) return
    const key = slug.toLowerCase()
    const bucket = index.get(key) ?? new Map<string, PageCandidate>()
    index.set(key, bucket)
    const id = `${model}\u0000${entry}`
    const existing = bucket.get(id)
    if (existing) {
      if (!existing.locales.includes(locale)) existing.locales.push(locale)
      existing.title ??= title
    }
    else {
      bucket.set(id, { model, entry, title, locales: [locale] })
    }
  }

  for (const [key, data] of brain.content) {
    const separator = key.indexOf(':')
    const modelId = key.slice(0, separator)
    const locale = key.slice(separator + 1)
    const model = brain.models.get(modelId)
    if (!model) continue

    if (model.kind === 'document' && Array.isArray(data)) {
      for (const raw of data) {
        const doc = raw as { slug?: string, frontmatter?: Record<string, unknown> }
        if (doc?.slug) add(doc.slug, modelId, doc.slug, pickLabel(doc.frontmatter), locale)
      }
    }
    else if (model.kind === 'collection' && data && typeof data === 'object' && !Array.isArray(data)) {
      const slugFields = Object.entries(model.fields ?? {}).filter(([, def]) => def.type === 'slug').map(([name]) => name)
      if (slugFields.length === 0) continue
      for (const [entryId, fields] of Object.entries(data as Record<string, Record<string, unknown>>)) {
        for (const field of slugFields) add(fields?.[field], modelId, entryId, pickLabel(fields), locale)
      }
    }
  }
  return index
}

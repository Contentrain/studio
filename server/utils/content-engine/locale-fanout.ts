import type { ContentrainConfig, ModelDefinition, RepoReader } from '@contentrain/types'
import { canonicalStringify, parseMarkdownFrontmatter } from '@contentrain/types'
import { localeAgnosticFieldIds } from '../../../shared/utils/locale-agnostic-fields'
import { toObjectMap } from './helpers'

type PathContext = { contentRoot: string }

/** An extra entry for `planContentSave`, addressed to another locale. */
export interface FanOutEntry {
  id?: string
  slug?: string
  locale: string
  data: Record<string, unknown>
}

export interface FanOutPlan {
  entries: FanOutEntry[]
  /** Field ids whose value was carried into another locale. */
  fields: string[]
  /** Locales that received a write, in config order. */
  locales: string[]
  /** Collection entry ids written per locale — the meta override needs them. */
  touchedIdsByLocale: Record<string, string[]>
}

const EMPTY: FanOutPlan = { entries: [], fields: [], locales: [], touchedIdsByLocale: {} }

function otherLocales(model: ModelDefinition, config: ContentrainConfig | null, locale: string): string[] {
  if (!model.i18n) return []
  const supported = config?.locales?.supported ?? []
  return supported.filter(l => l !== locale)
}

/** The locale-agnostic values the caller actually sent — presence, not truthiness: clearing an image is a value too. */
function sharedValues(model: ModelDefinition, data: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const fieldId of localeAgnosticFieldIds(model.fields)) {
    if (fieldId in data) out[fieldId] = data[fieldId]
  }
  return out
}

function differs(before: Record<string, unknown>, after: Record<string, unknown>): boolean {
  return canonicalStringify(before) !== canonicalStringify(after)
}

/**
 * The writes that carry a save's locale-agnostic values into the model's
 * other locales, so a media or relation edit lands everywhere at once rather
 * than in whichever locale happened to be selected.
 *
 * Only entries that already exist in the other locale are written — a partial
 * entry made of one image would fail that locale's required fields, and the
 * missing entry is a locale-coverage gap this save was not asked to fill. A
 * locale that already holds the value is left alone, so a no-op save stays a
 * no-op.
 */
export async function planLocaleFanOut(args: {
  reader: RepoReader
  pathCtx: PathContext
  model: ModelDefinition
  config: ContentrainConfig | null
  locale: string
  data: Record<string, unknown>
}): Promise<FanOutPlan> {
  const { reader, pathCtx, model, config, locale, data } = args
  const targets = otherLocales(model, config, locale)
  if (targets.length === 0 || model.kind === 'dictionary' || model.kind === 'document') return EMPTY

  const entries: FanOutEntry[] = []
  const fields = new Set<string>()
  const locales: string[] = []
  const touchedIdsByLocale: Record<string, string[]> = {}

  if (model.kind === 'singleton') {
    const shared = sharedValues(model, data)
    if (Object.keys(shared).length === 0) return EMPTY
    for (const target of targets) {
      let existing: Record<string, unknown>
      try {
        existing = JSON.parse(await reader.readFile(resolveContentPath(pathCtx, model, target))) as Record<string, unknown>
      }
      catch {
        continue
      }
      const merged = { ...existing, ...shared }
      if (!differs(existing, merged)) continue
      entries.push({ locale: target, data: merged })
      locales.push(target)
      for (const fieldId of Object.keys(shared)) fields.add(fieldId)
    }
  }
  else {
    const incoming = toObjectMap(data) as Record<string, Record<string, unknown>>
    const sharedByEntry: Record<string, Record<string, unknown>> = {}
    for (const [entryId, entryData] of Object.entries(incoming)) {
      if (!entryData || typeof entryData !== 'object') continue
      const shared = sharedValues(model, entryData)
      if (Object.keys(shared).length > 0) sharedByEntry[entryId] = shared
    }
    if (Object.keys(sharedByEntry).length === 0) return EMPTY

    for (const target of targets) {
      let existing: Record<string, Record<string, unknown>>
      try {
        existing = toObjectMap(JSON.parse(await reader.readFile(resolveContentPath(pathCtx, model, target)))) as Record<string, Record<string, unknown>>
      }
      catch {
        continue
      }
      const touched: string[] = []
      for (const [entryId, shared] of Object.entries(sharedByEntry)) {
        const current = existing[entryId]
        if (!current) continue
        const merged = { ...current, ...shared }
        if (!differs(current, merged)) continue
        entries.push({ id: entryId, locale: target, data: merged })
        touched.push(entryId)
        for (const fieldId of Object.keys(shared)) fields.add(fieldId)
      }
      if (touched.length > 0) {
        locales.push(target)
        touchedIdsByLocale[target] = touched
      }
    }
  }

  if (entries.length === 0) return EMPTY
  return { entries, fields: [...fields], locales, touchedIdsByLocale }
}

/**
 * The document-kind counterpart: the same values carried into the other
 * locales' `{slug}/{locale}.md`, keeping each locale's own body and prose.
 */
export async function planDocumentLocaleFanOut(args: {
  reader: RepoReader
  pathCtx: PathContext
  model: ModelDefinition
  config: ContentrainConfig | null
  locale: string
  slug: string
  frontmatter: Record<string, unknown>
}): Promise<FanOutPlan> {
  const { reader, pathCtx, model, config, locale, slug, frontmatter } = args
  const targets = otherLocales(model, config, locale)
  if (targets.length === 0) return EMPTY
  const shared = sharedValues(model, frontmatter)
  if (Object.keys(shared).length === 0) return EMPTY

  const entries: FanOutEntry[] = []
  const locales: string[] = []
  for (const target of targets) {
    let existingFrontmatter: Record<string, unknown>
    let existingBody: string
    try {
      const parsed = parseMarkdownFrontmatter(await reader.readFile(resolveContentPath(pathCtx, model, target, slug)))
      existingFrontmatter = (parsed.frontmatter ?? {}) as Record<string, unknown>
      existingBody = parsed.body ?? ''
    }
    catch {
      continue
    }
    const merged = { ...existingFrontmatter, ...shared }
    if (!differs(existingFrontmatter, merged)) continue
    entries.push({ slug, locale: target, data: { ...merged, slug, body: existingBody } })
    locales.push(target)
  }

  if (entries.length === 0) return EMPTY
  return { entries, fields: Object.keys(shared), locales, touchedIdsByLocale: {} }
}

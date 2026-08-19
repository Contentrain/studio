/**
 * Turn a `cr/*` branch's file diff into the change an editor actually made.
 *
 * The review panel used to receive git's answer — these files differ, here are
 * their bytes — and had to guess the rest. It guessed wrong in the one way that
 * matters: the top-level keys of a collection file are entry ids, so the panel
 * labelled a whole entry as a "field" and printed two JSON objects for a
 * one-word edit.
 *
 * This module answers the editor's question instead: which entries changed,
 * which of their fields, and what the values were before and after. Everything
 * it needs is already in the project — the model definitions carry field types,
 * labels and `title_field`; the meta files carry status, author and timestamp.
 *
 * Two properties are deliberate:
 *
 * - **Paths are classified by forward generation, not by parsing.** For every
 *   model × locale the expected content and meta paths are produced with the
 *   same `resolveContentPath` / `resolveMetaPath` helpers the write path uses
 *   (which delegate to MCP's canonical `contentFilePath` / `metaFilePath`), and
 *   a changed path is matched against that set. Where a candidate has to be
 *   extracted from the path — documents, whose slug only exists there — it is
 *   verified by regenerating the path and comparing. A second path grammar
 *   would drift from MCP's; this one cannot.
 *
 * - **Nothing is silently dropped.** A path that matches no model lands in
 *   `unclassified` and the panel shows it. An editor approving a branch is
 *   entitled to know that something in it went unexplained.
 */
import type { ContentrainConfig, EntryMeta, FieldDef, FileDiff, ModelDefinition, Vocabulary } from '@contentrain/types'
import { orderedFieldNames, parseMarkdownFrontmatter, PATH_PATTERNS } from '@contentrain/types'
import type {
  BranchReview,
  ReviewEntryChange,
  ReviewFieldChange,
  ReviewGroup,
  ReviewSchemaChange,
  ReviewSchemaFieldChange,
  ReviewSettingsChange,
  ReviewUnclassifiedFile,
} from '../../shared/utils/branch-review'
import {
  parseBranchName,
  REVIEW_ENTRY_LIMIT,
  REVIEW_REF_LABEL_LIMIT,
  REVIEW_VALUE_LIMIT,
} from '../../shared/utils/branch-review'
import { fieldLabel } from '../../shared/utils/field-label'
import { resolveEntryTitle } from '../../shared/utils/entry-title'
import { findRelationLabel, inferFieldType, toSelectableRefs } from '../../shared/utils/content-relations'
import {
  resolveConfigPath,
  resolveContentPath,
  resolveContextPath,
  resolveMetaPath,
  resolveModelsDir,
  resolveVocabularyPath,
} from './content-paths'
import { toObjectMap } from './content-engine/helpers'

/** Read a path at a ref. Returns null when the file is absent at that ref. */
export type ReviewReader = (path: string, ref: string) => Promise<string | null>

export interface BranchReviewInput {
  branch: string
  files: FileDiff[]
  read: ReviewReader
  /** Ref holding the "before" state — the `contentrain` branch. */
  baseRef: string
  /** Ref holding the "after" state — the `cr/*` branch under review. */
  branchRef: string
  /** Models as of the base ref. Models the branch adds are merged in here. */
  models: Map<string, ModelDefinition>
  config: ContentrainConfig | null
  contentRoot: string
  /**
   * Base-branch content for a model + locale, used to title relation targets.
   * Optional: without it, relation values render as the refs they are.
   */
  relationSource?: (modelId: string, locale: string) => unknown
  canMerge: boolean
  canReject: boolean
}

// ─── Path classification ──────────────────────────────

type PathClass
  = | { type: 'content', model: ModelDefinition, locale: string, slug?: string }
    | { type: 'meta', model: ModelDefinition, locale: string, slug?: string }
    | { type: 'schema', modelId: string }
    | { type: 'config' }
    | { type: 'vocabulary' }
    | { type: 'context' }

/**
 * The meta directory for a model, derived from the declared path pattern
 * rather than spelled out again here. Only the prefix test is derived; every
 * candidate it produces is verified against `resolveMetaPath` before use.
 */
function metaDirFor(contentRoot: string, modelId: string): string {
  const dir = (PATH_PATTERNS.meta.document.split('/{slug}/')[0] ?? '').replace('{modelId}', modelId)
  return contentRoot ? `${contentRoot}/${dir}` : dir
}

/**
 * Candidate (locale, slug) pairs for a document path, one per locale layout.
 * Each is a guess; the caller confirms it by regenerating the path.
 */
function documentCandidates(relative: string, locales: string[]): Array<{ locale: string, slug: string }> {
  const segments = relative.split('/')
  const file = segments[segments.length - 1] ?? ''
  if (!file.endsWith('.md') && !file.endsWith('.json')) return []
  const stem = file.replace(/\.(?:md|json)$/, '')
  const out: Array<{ locale: string, slug: string }> = []

  // {slug}/{locale}.md — the "file" strategy, and the meta layout
  if (segments.length >= 2) out.push({ locale: stem, slug: segments[segments.length - 2] ?? '' })
  // {locale}/{slug}.md — the "directory" strategy
  if (segments.length >= 2) out.push({ locale: segments[segments.length - 2] ?? '', slug: stem })
  // {slug}.{locale}.md — the "suffix" strategy
  const dot = stem.lastIndexOf('.')
  if (dot > 0) out.push({ locale: stem.slice(dot + 1), slug: stem.slice(0, dot) })
  // {slug}.md — no locale in the path (i18n: false, or the "none" strategy)
  for (const locale of locales) out.push({ locale, slug: stem })

  return out.filter(c => c.locale && c.slug)
}

function buildClassifier(
  contentRoot: string,
  models: Map<string, ModelDefinition>,
  locales: string[],
  defaultLocale: string,
): (path: string) => PathClass | null {
  const ctx = { contentRoot }
  const exact = new Map<string, PathClass>()
  const documents: Array<{ model: ModelDefinition, contentDir: string, metaDir: string }> = []

  for (const model of models.values()) {
    if (model.kind === 'document') {
      try {
        documents.push({
          // With no slug, `resolveContentPath` returns the model's directory.
          contentDir: resolveContentPath(ctx, model, defaultLocale),
          metaDir: metaDirFor(contentRoot, model.id),
          model,
        })
      }
      catch { /* invalid content_path — its files fall through to unclassified */ }
      continue
    }

    // A non-i18n model collapses every locale onto one file, so computing it
    // once keeps the map honest about which locale the change belongs to.
    for (const locale of model.i18n ? locales : [defaultLocale]) {
      try {
        exact.set(resolveContentPath(ctx, model, locale), { type: 'content', model, locale })
        exact.set(resolveMetaPath(ctx, model, locale, defaultLocale), { type: 'meta', model, locale })
      }
      catch { /* invalid content_path — its files fall through to unclassified */ }
    }
  }

  const configPath = resolveConfigPath(ctx)
  const vocabularyPath = resolveVocabularyPath(ctx)
  const contextPath = resolveContextPath(ctx)
  const modelsPrefix = `${resolveModelsDir(ctx)}/`

  return (path: string): PathClass | null => {
    const hit = exact.get(path)
    if (hit) return hit

    if (path === configPath) return { type: 'config' }
    if (path === vocabularyPath) return { type: 'vocabulary' }
    if (path === contextPath) return { type: 'context' }
    if (path.startsWith(modelsPrefix) && path.endsWith('.json'))
      return { type: 'schema', modelId: path.slice(modelsPrefix.length, -'.json'.length) }

    for (const { model, contentDir, metaDir } of documents) {
      const isContent = path.startsWith(`${contentDir}/`)
      const isMeta = path.startsWith(`${metaDir}/`)
      if (!isContent && !isMeta) continue

      const relative = path.slice((isContent ? contentDir : metaDir).length + 1)
      for (const { locale, slug } of documentCandidates(relative, locales)) {
        // The guess only counts if the canonical helper agrees.
        const expected = isContent
          ? resolveContentPath(ctx, model, locale, slug)
          : resolveMetaPath(ctx, model, locale, defaultLocale, slug)
        if (expected === path)
          return { type: isContent ? 'content' : 'meta', model, locale, slug }
      }
    }

    return null
  }
}

// ─── Value + field diffing ────────────────────────────

/** Long-form values cross the wire clipped; the panel says when they were. */
function clipValue(value: unknown): { value: unknown, truncated: boolean } {
  if (typeof value === 'string' && value.length > REVIEW_VALUE_LIMIT)
    return { value: value.slice(0, REVIEW_VALUE_LIMIT), truncated: true }
  return { value, truncated: false }
}

function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null)
}

/**
 * Field ids in the order an editor should read them: the model's declared
 * order first (`FieldDef.order`, then alphabetical — `orderedFieldNames`),
 * then anything the entry carries that the schema does not model (hand-edited
 * frontmatter, dictionary keys), alphabetically.
 */
function orderedKeys(fields: Record<string, FieldDef>, present: Set<string>): string[] {
  const declared = orderedFieldNames(fields).filter(id => present.has(id))
  const seen = new Set(declared)
  const extras = [...present].filter(id => !seen.has(id)).sort()
  return [...declared, ...extras]
}

/** Refs a relation value points at, whatever shape it is stored in. */
function relationRefs(value: unknown): string[] {
  const out: string[] = []
  const push = (item: unknown) => {
    if (typeof item === 'string') out.push(item)
    else if (item && typeof item === 'object' && 'ref' in item)
      out.push(String((item as { ref: unknown }).ref))
  }
  if (Array.isArray(value)) value.forEach(push)
  else if (value !== null && value !== undefined) push(value)
  return out
}

function buildFieldChange(
  fieldId: string,
  def: FieldDef | undefined,
  before: unknown,
  after: unknown,
  ctx: { locale: string, defaultLocale: string, fallbackType?: string, humanize?: boolean },
): ReviewFieldChange {
  const clippedBefore = clipValue(before)
  const clippedAfter = clipValue(after)
  return {
    fieldId,
    label: fieldLabel(fieldId, def, { locale: ctx.locale, defaultLocale: ctx.defaultLocale, humanize: ctx.humanize }),
    type: def?.type ?? ctx.fallbackType ?? inferFieldType(after ?? before),
    before: clippedBefore.value,
    after: clippedAfter.value,
    ...(clippedBefore.truncated || clippedAfter.truncated ? { truncated: true } : {}),
  }
}

// ─── Builder ──────────────────────────────────────────

interface GroupBucket {
  model: ModelDefinition
  locale: string
  /** Path → the slug it carries, for documents. One file per entry there. */
  contentPaths: Map<string, string | undefined>
  metaPaths: Map<string, string | undefined>
}

type EntryTable = Map<string, Record<string, unknown>>
type MetaTable = Map<string, Partial<EntryMeta>>

/** Parse one content file into entries keyed the way the model keys them. */
function readEntries(model: ModelDefinition, raw: string | null, slug?: string): EntryTable {
  if (raw === null) return new Map()

  if (model.kind === 'document') {
    const parsed = parseMarkdownFrontmatter(raw)
    return new Map([[slug ?? '', { ...parsed.frontmatter, body: parsed.body }]])
  }

  let data: unknown
  try {
    data = JSON.parse(raw)
  }
  catch {
    return new Map()
  }

  // A collection file is a map (or, from MCP's array form, normalised into
  // one) of entry id → fields. A singleton or a dictionary IS one record, so
  // it becomes a single entry keyed by the model — its "fields" are the
  // record's own keys, which is exactly what an editor edits.
  if (model.kind === 'collection') {
    return new Map(
      Object.entries(toObjectMap(data))
        .map(([id, entry]) => [id, (entry && typeof entry === 'object' ? entry : {}) as Record<string, unknown>]),
    )
  }

  return new Map([[model.id, (data && typeof data === 'object' ? data : {}) as Record<string, unknown>]])
}

function readMeta(model: ModelDefinition, raw: string | null, slug?: string): MetaTable {
  if (raw === null) return new Map()
  let data: unknown
  try {
    data = JSON.parse(raw)
  }
  catch {
    return new Map()
  }
  if (!data || typeof data !== 'object') return new Map()

  // Meta layout follows the kind, exactly as the status writer lays it down
  // (see `update-status.ts`): id-keyed for a collection, a single record for a
  // singleton or dictionary, and one record per slug file for a document.
  if (model.kind === 'collection')
    return new Map(Object.entries(data as Record<string, Partial<EntryMeta>>))

  return new Map([[model.kind === 'document' ? (slug ?? '') : model.id, data as Partial<EntryMeta>]])
}

async function buildGroup(
  bucket: GroupBucket,
  input: BranchReviewInput,
  defaultLocale: string,
): Promise<{ group: ReviewGroup | null, updatedBy: string | null, updatedAt: string | null }> {
  const { model, locale } = bucket
  const fields = (model.fields ?? {}) as Record<string, FieldDef>

  const before: EntryTable = new Map()
  const after: EntryTable = new Map()
  const metaBefore: MetaTable = new Map()
  const metaAfter: MetaTable = new Map()

  for (const [path, slug] of bucket.contentPaths) {
    const rawBefore = await input.read(path, input.baseRef)
    const rawAfter = await input.read(path, input.branchRef)
    for (const [id, entry] of readEntries(model, rawBefore, slug)) before.set(id, entry)
    for (const [id, entry] of readEntries(model, rawAfter, slug)) after.set(id, entry)
  }

  for (const [path, slug] of bucket.metaPaths) {
    const rawBefore = await input.read(path, input.baseRef)
    const rawAfter = await input.read(path, input.branchRef)
    for (const [id, meta] of readMeta(model, rawBefore, slug)) metaBefore.set(id, meta)
    for (const [id, meta] of readMeta(model, rawAfter, slug)) metaAfter.set(id, meta)
  }

  const ids = new Set([...before.keys(), ...after.keys(), ...metaAfter.keys()])
  const entries: ReviewEntryChange[] = []
  let latestBy: string | null = null
  let latestAt: string | null = null

  for (const entryId of [...ids].sort()) {
    const entryBefore = before.get(entryId)
    const entryAfter = after.get(entryId)
    const statusBefore = metaBefore.get(entryId)?.status ?? null
    const statusAfter = metaAfter.get(entryId)?.status ?? null
    const isNew = entryBefore === undefined && entryAfter !== undefined
    // A new entry always acquires a status, so `— → draft` is bookkeeping
    // rather than a decision. Anything else it was created as — published,
    // in review — is worth saying.
    const statusMoved = statusBefore !== statusAfter
      && statusAfter !== null
      && !(isNew && statusBefore === null && statusAfter === 'draft')

    // Both sides absent happens for a status-only write, where the meta file
    // moved and the content file did not: an update, not a creation.
    const kind: ReviewEntryChange['kind']
      = isNew
        ? 'added'
        : entryBefore !== undefined && entryAfter === undefined
          ? 'removed'
          : 'updated'

    const present = new Set([...Object.keys(entryBefore ?? {}), ...Object.keys(entryAfter ?? {})])
    // A document's body is content, not schema — it is never in `fields`, so
    // it would sort into the unmodelled tail. It is appended last on purpose.
    // Other kinds may legitimately declare a `body` field; theirs stays.
    if (model.kind === 'document') present.delete('body')

    const changed: ReviewFieldChange[] = []
    for (const fieldId of orderedKeys(fields, present)) {
      const valueBefore = entryBefore?.[fieldId]
      const valueAfter = entryAfter?.[fieldId]
      if (sameValue(valueBefore, valueAfter)) continue
      changed.push(buildFieldChange(fieldId, fields[fieldId], valueBefore, valueAfter, {
        locale,
        defaultLocale,
        fallbackType: model.kind === 'dictionary' ? 'string' : undefined,
        // A dictionary's ids are keys (`branch.reject`), not names — humanising
        // them produces `Branch.reject`, which is worse than the key itself.
        humanize: model.kind !== 'dictionary',
      }))
    }

    if (model.kind === 'document') {
      const bodyBefore = entryBefore?.body
      const bodyAfter = entryAfter?.body
      if (!sameValue(bodyBefore, bodyAfter)) {
        changed.push(buildFieldChange('body', { ...fields.body, type: 'markdown' }, bodyBefore, bodyAfter, {
          locale,
          defaultLocale,
        }))
      }
    }

    // A meta record that moved nothing but its own timestamp is bookkeeping,
    // not a change an editor should be asked to review.
    if (changed.length === 0 && !statusMoved && kind === 'updated') continue

    const updatedBy = metaAfter.get(entryId)?.updated_by ?? null
    const updatedAt = metaAfter.get(entryId)?.updated_at ?? null
    if (updatedAt && (!latestAt || updatedAt > latestAt)) {
      latestAt = updatedAt
      latestBy = updatedBy
    }
    else if (!latestBy && updatedBy) {
      latestBy = updatedBy
    }

    entries.push({
      kind,
      entryId,
      // A collection row or a document has a title of its own. A singleton or
      // a dictionary does not — it IS the model, and asking the title
      // inference for one gets whatever field it lands on: a settings
      // singleton came back titled `en`, off its `default_locale`.
      title: model.kind === 'collection' || model.kind === 'document'
        ? resolveEntryTitle(entryAfter ?? entryBefore, model, entryId)
        : (model.name || model.id),
      fields: changed,
      statusBefore: statusMoved ? statusBefore : null,
      statusAfter: statusMoved ? statusAfter : null,
      updatedBy,
      updatedAt,
    })
  }

  if (entries.length === 0) return { group: null, updatedBy: latestBy, updatedAt: latestAt }

  await attachRelationLabels(entries, fields, input, locale, defaultLocale)

  const omitted = Math.max(0, entries.length - REVIEW_ENTRY_LIMIT)
  return {
    group: {
      modelId: model.id,
      modelName: model.name || model.id,
      kind: model.kind,
      locale: model.i18n ? locale : null,
      entries: entries.slice(0, REVIEW_ENTRY_LIMIT),
      omittedEntries: omitted,
    },
    updatedBy: latestBy,
    updatedAt: latestAt,
  }
}

/**
 * Title the entries a relation points at. Two uuids either side of an arrow
 * say nothing; the titles are the same ones the entry list already shows.
 */
async function attachRelationLabels(
  entries: ReviewEntryChange[],
  fields: Record<string, FieldDef>,
  input: BranchReviewInput,
  locale: string,
  defaultLocale: string,
): Promise<void> {
  if (!input.relationSource) return
  // A target model may be non-i18n, in which case its content is held under
  // the default locale whatever locale the pointing entry belongs to.
  const load = (modelId: string) =>
    input.relationSource!(modelId, locale) ?? input.relationSource!(modelId, defaultLocale)

  for (const entry of entries) {
    for (const field of entry.fields) {
      if (field.type !== 'relation' && field.type !== 'relations') continue
      const def = fields[field.fieldId]
      const targets = Array.isArray(def?.model) ? def.model : def?.model ? [def.model] : []
      if (targets.length === 0) continue

      const refs = new Set([...relationRefs(field.before), ...relationRefs(field.after)])
      if (refs.size === 0) continue

      const labels: Record<string, string> = {}
      for (const targetId of targets) {
        if (Object.keys(labels).length >= REVIEW_REF_LABEL_LIMIT) break
        const targetModel = input.models.get(targetId) ?? null
        const data = load(targetId)
        for (const { ref, entry: target } of toSelectableRefs(data)) {
          if (!refs.has(ref) || labels[ref]) continue
          if (Object.keys(labels).length >= REVIEW_REF_LABEL_LIMIT) break
          const label = findRelationLabel(target, targetModel)
          if (label) labels[ref] = label
        }
      }
      if (Object.keys(labels).length > 0) field.refLabels = labels
    }
  }
}

// ─── Schema + settings ────────────────────────────────

function schemaFieldChange(fieldId: string, def: FieldDef | undefined, locale: string, defaultLocale: string, fromType?: string): ReviewSchemaFieldChange {
  return {
    fieldId,
    label: fieldLabel(fieldId, def, { locale, defaultLocale }),
    type: def?.type ?? 'string',
    ...(fromType ? { fromType } : {}),
    ...(def?.required ? { required: true } : {}),
  }
}

function diffSchema(
  modelId: string,
  before: ModelDefinition | null,
  after: ModelDefinition | null,
  locale: string,
  defaultLocale: string,
): ReviewSchemaChange | null {
  if (!before && !after) return null

  const beforeFields = (before?.fields ?? {}) as Record<string, FieldDef>
  const afterFields = (after?.fields ?? {}) as Record<string, FieldDef>

  const added: ReviewSchemaFieldChange[] = []
  const removed: ReviewSchemaFieldChange[] = []
  const retyped: ReviewSchemaFieldChange[] = []

  for (const fieldId of orderedFieldNames(afterFields)) {
    if (!(fieldId in beforeFields)) {
      added.push(schemaFieldChange(fieldId, afterFields[fieldId], locale, defaultLocale))
      continue
    }
    const from = beforeFields[fieldId]?.type
    const to = afterFields[fieldId]?.type
    if (from && to && from !== to)
      retyped.push(schemaFieldChange(fieldId, afterFields[fieldId], locale, defaultLocale, from))
  }
  for (const fieldId of orderedFieldNames(beforeFields)) {
    if (!(fieldId in afterFields))
      removed.push(schemaFieldChange(fieldId, beforeFields[fieldId], locale, defaultLocale))
  }

  const titleFieldBefore = before?.title_field ?? null
  const titleFieldAfter = after?.title_field ?? null
  const titleChanged = titleFieldBefore !== titleFieldAfter

  if (before && after && added.length === 0 && removed.length === 0 && retyped.length === 0 && !titleChanged)
    return null

  return {
    kind: !before ? 'added' : !after ? 'removed' : 'updated',
    modelId,
    modelName: after?.name || before?.name || modelId,
    added,
    removed,
    retyped,
    titleFieldBefore: titleChanged ? titleFieldBefore : null,
    titleFieldAfter: titleChanged ? titleFieldAfter : null,
    // Dropping a model, dropping a field, or changing a field's type can all
    // leave existing content behind. That is a different kind of approval.
    destructive: !after || removed.length > 0 || retyped.length > 0,
  }
}

function diffConfig(before: ContentrainConfig | null, after: ContentrainConfig | null): ReviewSettingsChange[] {
  if (!after) return []
  const out: ReviewSettingsChange[] = []

  const beforeLocales = new Set(before?.locales?.supported ?? [])
  const afterLocales = new Set(after.locales?.supported ?? [])
  const addedLocales = [...afterLocales].filter(l => !beforeLocales.has(l))
  const removedLocales = [...beforeLocales].filter(l => !afterLocales.has(l))
  const localeItems: ReviewSettingsChange['items'] = []
  if (addedLocales.length > 0) localeItems.push({ key: 'locale_added', values: addedLocales })
  if (removedLocales.length > 0) localeItems.push({ key: 'locale_removed', values: removedLocales })
  if (before && after.locales?.default !== before.locales?.default)
    localeItems.push({ key: 'default_locale', values: [String(after.locales?.default ?? '')] })
  if (localeItems.length > 0) out.push({ area: 'locales', items: localeItems })

  if (before && after.workflow !== before.workflow)
    out.push({ area: 'workflow', items: [{ key: 'workflow', values: [String(after.workflow)] }] })

  return out
}

function diffVocabulary(before: Vocabulary | null, after: Vocabulary | null): ReviewSettingsChange[] {
  if (!after) return []
  const beforeTerms = before?.terms ?? {}
  const afterTerms = after.terms ?? {}

  const added = Object.keys(afterTerms).filter(term => !(term in beforeTerms))
  const removed = Object.keys(beforeTerms).filter(term => !(term in afterTerms))
  const changed = Object.keys(afterTerms).filter(
    term => term in beforeTerms && !sameValue(beforeTerms[term], afterTerms[term]),
  )

  const items: ReviewSettingsChange['items'] = []
  if (added.length > 0) items.push({ key: 'term_added', values: added })
  if (removed.length > 0) items.push({ key: 'term_removed', values: removed })
  if (changed.length > 0) items.push({ key: 'term_updated', values: changed })

  return items.length > 0 ? [{ area: 'vocabulary', items }] : []
}

// ─── Entry point ──────────────────────────────────────

async function readJson<T>(read: ReviewReader, path: string, ref: string): Promise<T | null> {
  const raw = await read(path, ref)
  if (raw === null) return null
  try {
    return JSON.parse(raw) as T
  }
  catch {
    return null
  }
}

/**
 * Merge in models the branch itself adds. Without this, content written for a
 * brand-new model classifies as unknown — the brain only knows what is already
 * on `contentrain`.
 */
async function withBranchModels(input: BranchReviewInput, modelsPrefix: string): Promise<Map<string, ModelDefinition>> {
  const merged = new Map(input.models)
  for (const file of input.files) {
    if (file.status === 'removed') continue
    if (!file.path.startsWith(modelsPrefix) || !file.path.endsWith('.json')) continue
    const definition = await readJson<ModelDefinition>(input.read, file.path, input.branchRef)
    if (definition?.id) merged.set(definition.id, definition)
  }
  return merged
}

export async function buildBranchReview(input: BranchReviewInput): Promise<BranchReview> {
  const ctx = { contentRoot: input.contentRoot }
  const defaultLocale = input.config?.locales?.default ?? 'en'
  const locales = [...new Set([defaultLocale, ...(input.config?.locales?.supported ?? [])])]
  const modelsPrefix = `${resolveModelsDir(ctx)}/`

  const models = await withBranchModels(input, modelsPrefix)
  const classify = buildClassifier(input.contentRoot, models, locales, defaultLocale)

  const buckets = new Map<string, GroupBucket>()
  const schemaIds = new Set<string>()
  const unclassified: ReviewUnclassifiedFile[] = []
  let configTouched = false
  let vocabularyTouched = false

  for (const file of input.files) {
    const found = classify(file.path)
    if (!found) {
      unclassified.push({ path: file.path, status: file.status })
      continue
    }

    switch (found.type) {
      case 'config':
        configTouched = true
        break
      case 'vocabulary':
        vocabularyTouched = true
        break
      case 'schema':
        schemaIds.add(found.modelId)
        break
      // `context.json` is machine bookkeeping regenerated after every merge —
      // it never belongs on a feature branch, and never in a review.
      case 'context':
        break
      default: {
        const key = `${found.model.id}:${found.model.i18n ? found.locale : ''}`
        const bucket = buckets.get(key) ?? {
          model: found.model,
          locale: found.locale,
          contentPaths: new Map<string, string | undefined>(),
          metaPaths: new Map<string, string | undefined>(),
        }
        if (found.type === 'content') bucket.contentPaths.set(file.path, found.slug)
        else bucket.metaPaths.set(file.path, found.slug)
        buckets.set(key, bucket)
      }
    }
  }

  const groups: ReviewGroup[] = []
  let updatedBy: string | null = null
  let updatedAt: string | null = null

  for (const bucket of buckets.values()) {
    const result = await buildGroup(bucket, { ...input, models }, defaultLocale)
    if (result.group) groups.push(result.group)
    if (result.updatedAt && (!updatedAt || result.updatedAt > updatedAt)) {
      updatedAt = result.updatedAt
      updatedBy = result.updatedBy
    }
    else if (!updatedBy && result.updatedBy) {
      updatedBy = result.updatedBy
    }
  }
  groups.sort((a, b) => a.modelName.localeCompare(b.modelName) || (a.locale ?? '').localeCompare(b.locale ?? ''))

  const schema: ReviewSchemaChange[] = []
  for (const modelId of [...schemaIds].sort()) {
    const path = `${modelsPrefix}${modelId}.json`
    const [before, after] = await Promise.all([
      readJson<ModelDefinition>(input.read, path, input.baseRef),
      readJson<ModelDefinition>(input.read, path, input.branchRef),
    ])
    const change = diffSchema(modelId, before, after, defaultLocale, defaultLocale)
    if (change) schema.push(change)
  }

  const settings: ReviewSettingsChange[] = []
  if (configTouched) {
    const path = resolveConfigPath(ctx)
    const [before, after] = await Promise.all([
      readJson<ContentrainConfig>(input.read, path, input.baseRef),
      readJson<ContentrainConfig>(input.read, path, input.branchRef),
    ])
    settings.push(...diffConfig(before, after))
  }
  if (vocabularyTouched) {
    const path = resolveVocabularyPath(ctx)
    const [before, after] = await Promise.all([
      readJson<Vocabulary>(input.read, path, input.baseRef),
      readJson<Vocabulary>(input.read, path, input.branchRef),
    ])
    settings.push(...diffVocabulary(before, after))
  }

  const summary = { added: 0, updated: 0, removed: 0 }
  for (const group of groups) {
    for (const entry of group.entries) summary[entry.kind]++
  }

  const parsed = parseBranchName(input.branch)
  // Only `content` and `model` branches name a model in their `target` — a
  // `config` branch's target is `locales` or `vocabulary`, which is not one.
  const namesModel = parsed.scope === 'content' || parsed.scope === 'model'
  const scopeModel = namesModel && parsed.target ? models.get(parsed.target) : undefined

  return {
    branch: input.branch,
    info: {
      scope: parsed.scope,
      modelId: namesModel ? parsed.target : null,
      modelName: namesModel ? (scopeModel?.name || scopeModel?.id || groups[0]?.modelName || null) : null,
      locale: parsed.locale,
      timestamp: parsed.timestamp,
      updatedBy,
      updatedAt,
    },
    groups,
    schema,
    settings,
    unclassified,
    summary,
    canMerge: input.canMerge,
    canReject: input.canReject,
  }
}

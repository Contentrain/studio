import type { ModelDefinition, ValidationError } from '@contentrain/types'
import { parseMarkdownFrontmatter } from '@contentrain/types'
import type { EngineInternalContext, SaveOptions, WriteResult } from './types'
import { STUDIO_AUTHOR } from './types'
import { openWriteSnapshot, toObjectMap } from './helpers'
import { saveContent } from './save-content'
import { saveDocuments } from './save-document'

/**
 * Exact find/replace inside text fields (#282).
 *
 * To change one word, link or URL in a long markdown field the agent used to
 * re-send the whole field, often 3–11K characters. Regenerating long Turkish
 * text is lossy: it dropped `ğ`, merged words, lost an H1 and an intro that
 * were outside the change, and "N articles fixed" saved fewer than N.
 *
 * Here the agent sends only `find` → `replace`. The match is applied to the
 * text as read from the write snapshot, and the write forks from that same
 * commit — so nothing outside the match can change, and a redo after a merge
 * conflict applies the same edit to the newer text. A `find` that matches
 * nothing is an error, and one failing edit writes none of them.
 */

export interface TextEdit {
  /** Collection entry id or document slug. Absent for a singleton or dictionary. */
  entry?: string
  /** Field name; `body` for a document's markdown body; the key of a dictionary. */
  field: string
  find: string
  replace: string
  /** 1-based: replace only this occurrence. Absent: every occurrence. */
  occurrence?: number
}

export interface TextReplacement {
  entry?: string
  field: string
  replaced: number
}

export const MAX_TEXT_EDITS = 50

/** A relation value is an entry reference, not text — rewriting it would repoint it. */
const NON_TEXT_FIELD_TYPES = new Set(['relation', 'relations'])

/** Replace `find` in `text`: every occurrence, or only the 1-based `occurrence`. */
export function replaceExact(text: string, find: string, replace: string, occurrence?: number): { text: string, matches: number, replaced: number } {
  const positions: number[] = []
  for (let at = text.indexOf(find); at !== -1; at = text.indexOf(find, at + find.length)) positions.push(at)
  const targets = occurrence === undefined ? positions : positions.slice(occurrence - 1, occurrence)
  let out = text
  for (const at of targets.toReversed()) out = out.slice(0, at) + replace + out.slice(at + find.length)
  return { text: out, matches: positions.length, replaced: targets.length }
}

function countCaseInsensitive(text: string, find: string): number {
  const haystack = text.toLocaleLowerCase()
  const needle = find.toLocaleLowerCase()
  let count = 0
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + needle.length)) count++
  return count
}

/** The text values an entry holds, keyed by field — `body` included for a document. */
type EntryText = Record<string, unknown>

/**
 * Apply every edit to the entries' current values. Returns the changed fields
 * per entry, or the edits that could not be applied — never a partial result.
 */
export function applyTextEdits(
  model: ModelDefinition,
  locale: string,
  edits: TextEdit[],
  current: (entry: string | undefined) => EntryText | null,
): { changed: Map<string, Record<string, string>>, replacements: TextReplacement[], errors: ValidationError[] } {
  const keyed = model.kind === 'collection' || model.kind === 'document'
  const changed = new Map<string, Record<string, string>>()
  const replacements: TextReplacement[] = []
  const errors: ValidationError[] = []
  const fail = (edit: TextEdit, message: string) =>
    errors.push({ field: edit.field, ...(edit.entry ? { entry: edit.entry } : {}), locale, message, severity: 'error' })

  for (const edit of edits) {
    // Document slugs are stored lowercase; two spellings are one document.
    const rawKey = keyed ? edit.entry ?? '' : ''
    const entryKey = model.kind === 'document' ? rawKey.toLowerCase() : rawKey
    if (keyed && !entryKey) {
      fail(edit, `\`entry\` is required for a ${model.kind}`)
      continue
    }
    if (typeof edit.find !== 'string' || edit.find.length === 0) {
      fail(edit, '`find` must be non-empty text')
      continue
    }
    if (typeof edit.replace !== 'string') {
      fail(edit, '`replace` must be text (use "" to delete the match)')
      continue
    }
    if (edit.occurrence !== undefined && (!Number.isInteger(edit.occurrence) || edit.occurrence < 1)) {
      fail(edit, '`occurrence` must be a whole number from 1')
      continue
    }
    const fieldType = model.fields?.[edit.field]?.type
    if (fieldType && NON_TEXT_FIELD_TYPES.has(fieldType)) {
      fail(edit, `${edit.field} is a ${fieldType} field, not text — change it with save_content`)
      continue
    }

    const entry = current(keyed ? entryKey : undefined)
    if (!entry) {
      fail(edit, `no ${model.kind === 'document' ? 'document' : 'entry'} "${entryKey}" in ${locale}`)
      continue
    }
    const pending = changed.get(entryKey)
    const value = pending?.[edit.field] ?? entry[edit.field]
    if (typeof value !== 'string') {
      fail(edit, value === undefined ? `the entry has no ${edit.field} value` : `${edit.field} is not a text value`)
      continue
    }

    const result = replaceExact(value, edit.find, edit.replace, edit.occurrence)
    if (result.matches === 0) {
      const loose = countCaseInsensitive(value, edit.find)
      fail(edit, `\`find\` text not found${loose > 0 ? ` (${loose} match${loose === 1 ? '' : 'es'} with different letter case — \`find\` is case-sensitive)` : ''}; copy it exactly from the current value`)
      continue
    }
    if (result.replaced === 0) {
      fail(edit, `\`occurrence\` ${edit.occurrence} requested, but \`find\` occurs ${result.matches} time${result.matches === 1 ? '' : 's'}`)
      continue
    }
    if (model.kind === 'document' && edit.field === 'body' && !result.text.trim()) {
      fail(edit, 'the replacement would leave the body empty')
      continue
    }

    changed.set(entryKey, { ...pending, [edit.field]: result.text })
    replacements.push({ ...(edit.entry ? { entry: edit.entry } : {}), field: edit.field, replaced: result.replaced })
  }

  return { changed, replacements, errors }
}

function refused(errors: ValidationError[]): WriteResult & { replacements?: TextReplacement[] } {
  return {
    branch: '',
    commit: { sha: '', message: '', author: STUDIO_AUTHOR, timestamp: '' },
    diff: [],
    validation: { valid: false, errors },
  }
}

/** Apply `edits` to one model + locale in one commit, all-or-nothing. */
export async function replaceText(
  ctx: EngineInternalContext,
  modelId: string,
  locale: string,
  edits: TextEdit[],
  userEmail: string,
  options?: SaveOptions,
): Promise<WriteResult & { replacements?: TextReplacement[] }> {
  if (edits.length === 0 || edits.length > MAX_TEXT_EDITS)
    return refused([{ field: '', message: `A text edit takes 1 to ${MAX_TEXT_EDITS} edits, got ${edits.length}.`, severity: 'error' }])

  await ctx.ensureContentBranch()
  const snapshot = await openWriteSnapshot(ctx.git)
  const reader = snapshot.reader
  const model = JSON.parse(await reader.readFile(resolveModelPath(ctx.pathCtx, modelId))) as ModelDefinition

  const readJson = async (): Promise<Record<string, unknown>> => {
    try {
      return toObjectMap(JSON.parse(await reader.readFile(resolveContentPath(ctx.pathCtx, model, locale))))
    }
    catch {
      return {}
    }
  }

  let current: (entry: string | undefined) => EntryText | null
  if (model.kind === 'document') {
    const docs = new Map<string, EntryText | null>()
    for (const slug of new Set(edits.map(e => e.entry?.toLowerCase()).filter((s): s is string => !!s))) {
      try {
        const parsed = parseMarkdownFrontmatter(await reader.readFile(resolveContentPath(ctx.pathCtx, model, locale, slug)))
        docs.set(slug, { ...(parsed.frontmatter ?? {}), body: parsed.body ?? '' })
      }
      catch {
        docs.set(slug, null)
      }
    }
    current = entry => docs.get(entry?.toLowerCase() ?? '') ?? null
  }
  else {
    const content = await readJson()
    current = model.kind === 'collection'
      ? entry => (entry && content[entry] && typeof content[entry] === 'object' ? content[entry] as EntryText : null)
      : () => content
  }

  const { changed, replacements, errors } = applyTextEdits(model, locale, edits, current)
  if (errors.length > 0) return refused(errors)

  const writeOptions: SaveOptions = { ...options, mode: 'update', snapshot }
  let result: WriteResult
  if (model.kind === 'document') {
    const documents = [...changed].map(([slug, fields]) => {
      const { body, ...frontmatter } = fields
      return { slug, frontmatter, body: body ?? '' }
    })
    result = await saveDocuments(ctx, modelId, locale, documents, userEmail, writeOptions)
  }
  else if (model.kind === 'collection') {
    result = await saveContent(ctx, modelId, locale, Object.fromEntries(changed), userEmail, writeOptions)
  }
  else {
    result = await saveContent(ctx, modelId, locale, changed.get('') ?? {}, userEmail, writeOptions)
  }
  return result.validation.valid ? { ...result, replacements } : result
}

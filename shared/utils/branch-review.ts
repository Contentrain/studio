/**
 * The contract between the review endpoint and the review panel.
 *
 * The panel used to receive a git diff — a file list plus the raw before/after
 * bytes of every changed file — and was left to work out what any of it meant.
 * It could not: the top-level keys of a collection file are entry ids, not
 * fields, so "what changed" rendered as two whole JSON objects side by side.
 *
 * The server now answers the question the editor is actually asking — which
 * entries changed, and which of their fields — and this is the shape of that
 * answer. Everything here is data, never prose: the panel renders it through
 * `useContent().t()` like every other surface, so a summary line is a key plus
 * values rather than an English sentence minted on the server.
 */

/** How a thing changed. Shared by entries, models and schema fields. */
export type ReviewChangeKind = 'added' | 'updated' | 'removed'

/**
 * How a *file* changed. Git's vocabulary, kept separate from the entry one:
 * a file is `modified`, an entry is `updated`, and collapsing the two is what
 * lets a file-level status leak into an entry-level field.
 */
export type ReviewFileStatus = 'added' | 'modified' | 'removed'

/** One field of one entry, with only the values that actually differ. */
export interface ReviewFieldChange {
  fieldId: string
  /** Resolved from `FieldDef.label` for the locale, falling back to the id. */
  label: string
  /** Field type, so the panel can render the value rather than stringify it. */
  type: string
  before: unknown
  after: unknown
  /** A long text value was clipped for transport — the panel says so. */
  truncated?: boolean
  /**
   * Human titles for relation references, keyed by ref. A relation diff that
   * shows two uuids tells an editor nothing; this is what turns them into the
   * titles they already see in the entry list.
   */
  refLabels?: Record<string, string>
}

/** One entry (collection row, singleton, dictionary key, document). */
export interface ReviewEntryChange {
  kind: ReviewChangeKind
  entryId: string
  /** The entry's title via the model's `title_field`, id as last resort. */
  title: string
  fields: ReviewFieldChange[]
  /**
   * Status transition, derived from the meta file rather than shown as one.
   * Both null when the write did not move the entry's status.
   */
  statusBefore: string | null
  statusAfter: string | null
  /** Who wrote it and when — read from meta, not from a second git call. */
  updatedBy: string | null
  updatedAt: string | null
}

/** Entry changes belonging to one model + locale. */
export interface ReviewGroup {
  modelId: string
  modelName: string
  /** Model kind: collection | singleton | dictionary | document. */
  kind: string
  /** Null for a non-i18n model, where locale is not a fact about the change. */
  locale: string | null
  entries: ReviewEntryChange[]
  /**
   * Entries beyond the per-group cap, omitted from `entries`. A bulk import
   * can touch thousands of rows; the panel says how many it is not showing
   * rather than pretending the branch is smaller than it is.
   */
  omittedEntries: number
}

/** One field added to / removed from / retyped on a model. */
export interface ReviewSchemaFieldChange {
  fieldId: string
  label: string
  type: string
  /** Set only on a retype — the type the field had before. */
  fromType?: string
  required?: boolean
}

/**
 * A structural change. Louder than a content change in the UI, because it can
 * take content with it: removing a field or changing its type is not something
 * an editor should approve by accident.
 */
export interface ReviewSchemaChange {
  kind: ReviewChangeKind
  modelId: string
  modelName: string
  added: ReviewSchemaFieldChange[]
  removed: ReviewSchemaFieldChange[]
  retyped: ReviewSchemaFieldChange[]
  titleFieldBefore: string | null
  titleFieldAfter: string | null
  /** A removal or retype — existing content may not survive it. */
  destructive: boolean
}

/**
 * A project-settings change. `items[].key` names a dictionary entry
 * (`review.settings_{key}`) and `values` fills its `{values}` placeholder, so
 * the wording stays in the content layer where every other string lives.
 */
export interface ReviewSettingsChange {
  area: 'locales' | 'workflow' | 'vocabulary' | 'project'
  items: Array<{ key: string, values: string[] }>
}

/** What a `cr/*` branch name and its meta records say about the change. */
export interface BranchReviewInfo {
  /** `content` | `model` | `config` | `new` — from the branch name. */
  scope: string
  modelId: string | null
  /** The model's display name, resolved against the project's models. */
  modelName: string | null
  locale: string | null
  /** Unix seconds, from the branch name. Null when it does not parse. */
  timestamp: number | null
  /** Most recent `updated_by` / `updated_at` across the changed meta records. */
  updatedBy: string | null
  updatedAt: string | null
}

/** A path the classifier could not attribute to a model or a known file. */
export interface ReviewUnclassifiedFile {
  path: string
  status: ReviewFileStatus
}

/** The full answer for one pending branch. */
export interface BranchReview {
  branch: string
  info: BranchReviewInfo
  groups: ReviewGroup[]
  schema: ReviewSchemaChange[]
  settings: ReviewSettingsChange[]
  /**
   * Never silently dropped. A custom `content_path` or a file layout Studio
   * does not model still has to be visible — an editor approving a branch is
   * entitled to know something in it went unexplained.
   */
  unclassified: ReviewUnclassifiedFile[]
  summary: { added: number, updated: number, removed: number }
  /** Resolved from the caller's role, so the panel never offers a 403. */
  canMerge: boolean
  canReject: boolean
}

/** One row of the pending-changes list, already humanised. */
export interface BranchListItem {
  name: string
  sha: string
  protected: boolean
  scope: string
  modelId: string | null
  modelName: string | null
  locale: string | null
  timestamp: number | null
}

/**
 * How much of a single field value crosses the wire. Long-form fields
 * (markdown bodies, rich text) are the reason the old endpoint shipped whole
 * files; the panel only needs enough to show what changed.
 */
export const REVIEW_VALUE_LIMIT = 4000

/** Relation refs resolved to titles per field. Past this, refs render bare. */
export const REVIEW_REF_LABEL_LIMIT = 20

/** Entries carried per model+locale group before `omittedEntries` takes over. */
export const REVIEW_ENTRY_LIMIT = 200

/**
 * Split a `cr/*` branch name into its parts.
 *
 * Format (git-architecture.md §2.3, minted by `generateBranchName`):
 * `cr/{scope}/{target}[/{locale}]/{timestamp}-{suffix}`
 *
 * Pure and shared so the branch list, the review header and their tests all
 * read the same name the same way.
 */
export function parseBranchName(branch: string): {
  scope: string
  target: string | null
  locale: string | null
  timestamp: number | null
} {
  const parts = branch.split('/')
  if (parts[0] !== 'cr' || parts.length < 4)
    return { scope: '', target: null, locale: null, timestamp: null }

  const last = parts[parts.length - 1] ?? ''
  const stamp = last.match(/^(\d+)-/)?.[1]

  return {
    scope: parts[1] ?? '',
    target: parts[2] ?? null,
    // cr/scope/target/locale/stamp-suffix has 5 segments; without a locale, 4.
    locale: parts.length >= 5 ? (parts[3] ?? null) : null,
    timestamp: stamp ? Number(stamp) : null,
  }
}

import type { StudioTool } from './agent-types'

/**
 * Studio Agent Tool definitions with orchestration metadata.
 *
 * Each tool includes:
 * - requiredPhase: which project phases allow this tool
 * - defaultAffects: what resources this tool typically changes
 * - workflowBehavior: how merge works (auto-merge, review-dependent, manual)
 *
 * Tool descriptions are the agent's primary reference for HOW to use each tool.
 * They must be precise about Contentrain's data format, constraints, and conventions.
 */

export const STUDIO_TOOLS: StudioTool[] = [
  {
    name: 'list_models',
    description: 'List all content models with their full field schemas, kind, domain, and i18n settings.',
    inputSchema: { type: 'object', properties: {} },
    requiredPhase: ['uninitialized', 'init_pending', 'active', 'error'],
    defaultAffects: { snapshotChanged: false, branchesChanged: false },
    workflowBehavior: 'none',
  },
  {
    name: 'get_content',
    description: 'Read content entries for a model and locale. Returns object-map for collections ({entryId: {fields}}), flat object for singletons ({field: value}), flat key-value for dictionaries ({key: "string value"}). Use this to look up existing entry IDs before updating, or to find valid relation targets.',
    inputSchema: {
      type: 'object',
      properties: {
        model: { type: 'string', description: 'Model ID' },
        locale: { type: 'string', description: 'Locale code (defaults to context locale)' },
      },
      required: ['model'],
    },
    requiredPhase: ['active'],
    defaultAffects: { snapshotChanged: false, branchesChanged: false },
    workflowBehavior: 'none',
  },
  {
    name: 'save_content',
    description: `Create or update content. MERGES with existing data — only send changed fields.

FORMAT BY KIND:
- collection: { "existingOrNewEntryId": { field: value, ... } } — use EXISTING entry ID for updates, generate 12-char hex for NEW entries
- singleton: { field: value, ... } — merges with existing fields
- dictionary: { "key": "string value", ... } — ALL values must be strings

RELATION FIELDS:
- relation (single): set value to target entry ID (collection) or slug (document)
- relations (array): set value to string[] of IDs/slugs
- polymorphic (model is string[]): set value to { "model": "target-model", "ref": "id-or-slug" }

IMPORTANT: Never include system fields (id, slug, status, source) in data.`,
    inputSchema: {
      type: 'object',
      properties: {
        model: { type: 'string', description: 'Model ID' },
        locale: { type: 'string', description: 'Locale code (defaults to context locale)' },
        data: { type: 'object', description: 'Content data — only include fields that changed' },
        slug: { type: 'string', description: 'Document slug (required for document kind only)' },
        body: { type: 'string', description: 'Markdown body (document kind only)' },
      },
      required: ['model', 'data'],
    },
    requiredPhase: ['active'],
    defaultAffects: { snapshotChanged: false, branchesChanged: true },
    workflowBehavior: 'workflow-dependent',
  },
  {
    name: 'delete_content',
    description: 'Delete entries from a collection by their IDs, or keys from a dictionary. For collections: pass entry IDs. For dictionaries: pass keys as entryIds.',
    inputSchema: {
      type: 'object',
      properties: {
        model: { type: 'string', description: 'Model ID' },
        locale: { type: 'string', description: 'Locale code' },
        entryIds: { type: 'array', items: { type: 'string' }, description: 'Entry IDs (collection) or keys (dictionary) to delete' },
      },
      required: ['model', 'entryIds'],
    },
    requiredPhase: ['active'],
    defaultAffects: { snapshotChanged: false, branchesChanged: true },
    workflowBehavior: 'workflow-dependent',
  },
  {
    name: 'save_model',
    description: `Create or update a model definition. Field definitions use Contentrain's 27 type system.

FIELD DEF FORMAT: { "fieldId": { type, required?, unique?, min?, max?, pattern?, options?, model?, items?, fields?, default?, description? } }

RELATION FIELDS: Include "model" property with target model ID(s).
  Single target: { "type": "relation", "model": "team-members" }
  Multiple targets (polymorphic): { "type": "relations", "model": ["blog-post", "page"] }

ARRAY FIELDS: Include "items" property.
  Simple: { "type": "array", "items": "string" }
  Object items: { "type": "array", "items": { "type": "object", "fields": { ... } } }

OBJECT FIELDS: Include nested "fields" (max 2 levels deep).
  { "type": "object", "fields": { "street": { "type": "string" }, "city": { "type": "string" } } }

DICTIONARY: kind="dictionary" requires NO fields property. All content is free key-value strings.`,
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Model ID (kebab-case, lowercase)' },
        name: { type: 'string', description: 'Human-readable display name' },
        kind: { type: 'string', enum: ['singleton', 'collection', 'document', 'dictionary'], description: 'Content kind' },
        domain: { type: 'string', description: 'Content domain (directory name)' },
        i18n: { type: 'boolean', description: 'Multi-locale support' },
        description: { type: 'string', description: 'Model description' },
        fields: { type: 'object', description: 'Field definitions (not needed for dictionary)' },
      },
      required: ['id', 'name', 'kind', 'domain'],
    },
    requiredPhase: ['active'],
    defaultAffects: { snapshotChanged: true, branchesChanged: true },
    workflowBehavior: 'workflow-dependent',
  },
  {
    name: 'validate',
    description: 'Validate content against model schemas. Checks: required fields, type mismatches, relation integrity, locale parity.',
    inputSchema: {
      type: 'object',
      properties: {
        model: { type: 'string', description: 'Model ID (optional — validates all if omitted)' },
        locale: { type: 'string', description: 'Locale (optional)' },
      },
    },
    requiredPhase: ['active', 'uninitialized', 'init_pending', 'error'],
    defaultAffects: { snapshotChanged: false, branchesChanged: false },
    workflowBehavior: 'none',
  },
  {
    name: 'list_branches',
    description: 'List pending contentrain/* branches awaiting merge or review.',
    inputSchema: { type: 'object', properties: {} },
    requiredPhase: ['active', 'init_pending', 'error'],
    defaultAffects: { snapshotChanged: false, branchesChanged: false },
    workflowBehavior: 'none',
  },
  {
    name: 'merge_branch',
    description: 'Approve and merge a content branch into the default branch. Use after reviewing changes.',
    inputSchema: {
      type: 'object',
      properties: { branch: { type: 'string', description: 'Branch name (e.g., contentrain/save-abcd1234)' } },
      required: ['branch'],
    },
    requiredPhase: ['active', 'init_pending'],
    defaultAffects: { snapshotChanged: true, branchesChanged: true },
    workflowBehavior: 'manual',
  },
  {
    name: 'reject_branch',
    description: 'Reject and delete a content branch. Discards all changes in that branch.',
    inputSchema: {
      type: 'object',
      properties: { branch: { type: 'string', description: 'Branch name' } },
      required: ['branch'],
    },
    requiredPhase: ['active', 'init_pending'],
    defaultAffects: { branchesChanged: true, snapshotChanged: false },
    workflowBehavior: 'manual',
  },
  {
    name: 'init_project',
    description: `Initialize .contentrain/ structure in a new repository. Creates config.json, vocabulary.json, context.json, model definitions, and empty content files.

Provide initial models with full field definitions using Contentrain's 27 type system. Each model needs: id (kebab-case), name, kind, domain, i18n, and fields (except dictionary).`,
    inputSchema: {
      type: 'object',
      properties: {
        stack: { type: 'string', description: 'Framework: nuxt, next, astro, sveltekit, remix, vue, react, other' },
        locales: { type: 'array', items: { type: 'string' }, description: 'Supported locale codes (e.g., ["en", "tr"])' },
        domains: { type: 'array', items: { type: 'string' }, description: 'Content domains (e.g., ["marketing", "blog", "system"])' },
        models: {
          type: 'array',
          description: 'Initial model definitions with full field schemas',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              name: { type: 'string' },
              kind: { type: 'string', enum: ['singleton', 'collection', 'document', 'dictionary'] },
              domain: { type: 'string' },
              i18n: { type: 'boolean' },
              fields: { type: 'object' },
            },
            required: ['id', 'name', 'kind', 'domain'],
          },
        },
      },
      required: ['stack', 'locales', 'domains'],
    },
    requiredPhase: ['uninitialized'],
    defaultAffects: { snapshotChanged: true, branchesChanged: true },
    workflowBehavior: 'auto-merge',
  },
  {
    name: 'copy_locale',
    description: 'Copy content from one locale to another for a model. Useful for bootstrapping translations — copies all entries from source locale to target locale. Existing target content is NOT overwritten.',
    inputSchema: {
      type: 'object',
      properties: {
        model: { type: 'string', description: 'Model ID' },
        from: { type: 'string', description: 'Source locale code (e.g., "en")' },
        to: { type: 'string', description: 'Target locale code (e.g., "tr")' },
      },
      required: ['model', 'from', 'to'],
    },
    requiredPhase: ['active'],
    defaultAffects: { branchesChanged: true, snapshotChanged: false },
    workflowBehavior: 'workflow-dependent',
  },

  // ─── Media Tools ───

  {
    name: 'search_media',
    description: 'Search the project media library. Returns assets with variants, dimensions, blurhash, and alt text. Use this to find existing images before uploading new ones.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search by filename, alt text, or tags' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Filter by tags' },
        type: { type: 'string', description: 'Filter by MIME type prefix (e.g. "image", "video")' },
        limit: { type: 'number', description: 'Max results (default: 10)' },
      },
    },
    requiredPhase: ['active'],
    defaultAffects: { snapshotChanged: false, branchesChanged: false },
    workflowBehavior: 'none',
  },
  {
    name: 'upload_media',
    description: `Upload an image from URL to the project media library. Automatically optimizes, generates variants, and returns the media path. Use the returned path in save_content for image/video/file fields.

Example: upload_media({ url: "https://...", alt: "Hero banner" }) → { path: "media/original/abc123.webp", ... }
Then: save_content({ model: "hero", data: { cover: "media/original/abc123.webp" } })`,
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Source image URL to fetch and upload' },
        alt: { type: 'string', description: 'Alt text for accessibility' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Tags for organization' },
        variants: { type: 'string', description: 'Variant preset name (e.g. "hero-image", "avatar") or omit for default' },
      },
      required: ['url'],
    },
    requiredPhase: ['active'],
    defaultAffects: { snapshotChanged: false, branchesChanged: false },
    workflowBehavior: 'none',
  },
  {
    name: 'get_media',
    description: 'Get full metadata for a specific media asset by ID. Returns variants, dimensions, blurhash, alt, tags, and usage info.',
    inputSchema: {
      type: 'object',
      properties: {
        assetId: { type: 'string', description: 'Asset UUID' },
      },
      required: ['assetId'],
    },
    requiredPhase: ['active'],
    defaultAffects: { snapshotChanged: false, branchesChanged: false },
    workflowBehavior: 'none',
  },
]

/**
 * Filter tools by user permissions (role-based).
 */
export function filterToolsByPermissions(
  tools: StudioTool[],
  availableToolNames: string[],
): StudioTool[] {
  return tools.filter(t => availableToolNames.includes(t.name))
}

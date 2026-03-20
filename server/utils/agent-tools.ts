import type { AITool } from '../providers/ai'

/**
 * Studio Agent Tool definitions.
 *
 * These are NOT MCP tools — they're Studio's own tools.
 * The agent calls these via the chat engine tool loop.
 * Each tool is executed by the Content Engine.
 *
 * Tool format follows Anthropic/OpenAI JSON Schema convention.
 */

export const STUDIO_TOOLS: AITool[] = [
  {
    name: 'list_models',
    description: 'List all content models with their field schemas, kinds, domains, and i18n settings.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'get_content',
    description: 'Read content entries for a specific model and locale. Returns the full content data.',
    inputSchema: {
      type: 'object',
      properties: {
        model: { type: 'string', description: 'Model ID (e.g., "faq", "hero")' },
        locale: { type: 'string', description: 'Locale code (e.g., "en", "tr")' },
      },
      required: ['model'],
    },
  },
  {
    name: 'save_content',
    description: 'Save content entries. Creates a branch with the changes. For collections, provide an object-map { entryId: { fields } }. For singletons, provide { field: value }.',
    inputSchema: {
      type: 'object',
      properties: {
        model: { type: 'string', description: 'Model ID' },
        locale: { type: 'string', description: 'Locale code (default: "en")' },
        data: { type: 'object', description: 'Content data (object-map for collections, flat for singletons)' },
      },
      required: ['model', 'data'],
    },
  },
  {
    name: 'delete_content',
    description: 'Delete content entries from a collection by their IDs.',
    inputSchema: {
      type: 'object',
      properties: {
        model: { type: 'string', description: 'Model ID' },
        locale: { type: 'string', description: 'Locale code' },
        entryIds: { type: 'array', items: { type: 'string' }, description: 'Entry IDs to delete' },
      },
      required: ['model', 'entryIds'],
    },
  },
  {
    name: 'save_model',
    description: 'Create or update a model definition. Provide the full ModelDefinition object.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Model ID (kebab-case)' },
        name: { type: 'string', description: 'Human-readable name' },
        kind: { type: 'string', enum: ['singleton', 'collection', 'document', 'dictionary'], description: 'Model kind' },
        domain: { type: 'string', description: 'Content domain (e.g., "marketing", "system")' },
        i18n: { type: 'boolean', description: 'Enable multi-locale support' },
        fields: { type: 'object', description: 'Field definitions { fieldId: { type, required?, ... } }' },
      },
      required: ['id', 'name', 'kind', 'domain'],
    },
  },
  {
    name: 'validate',
    description: 'Run validation on content against model schemas. Returns errors and warnings.',
    inputSchema: {
      type: 'object',
      properties: {
        model: { type: 'string', description: 'Model ID (optional — validates all if omitted)' },
        locale: { type: 'string', description: 'Locale code (optional)' },
      },
    },
  },
  {
    name: 'list_branches',
    description: 'List pending contentrain/* branches (uncommitted content changes waiting for review).',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'merge_branch',
    description: 'Approve and merge a content branch into the default branch.',
    inputSchema: {
      type: 'object',
      properties: {
        branch: { type: 'string', description: 'Branch name to merge' },
      },
      required: ['branch'],
    },
  },
  {
    name: 'reject_branch',
    description: 'Reject and delete a content branch.',
    inputSchema: {
      type: 'object',
      properties: {
        branch: { type: 'string', description: 'Branch name to reject' },
      },
      required: ['branch'],
    },
  },
  {
    name: 'init_project',
    description: 'Initialize a .contentrain/ structure in a repository that doesn\'t have one yet.',
    inputSchema: {
      type: 'object',
      properties: {
        stack: { type: 'string', description: 'Detected or specified framework (nuxt, next, astro, etc.)' },
        locales: { type: 'array', items: { type: 'string' }, description: 'Supported locale codes' },
        domains: { type: 'array', items: { type: 'string' }, description: 'Content domains (e.g., ["marketing", "system"])' },
      },
      required: ['stack', 'locales', 'domains'],
    },
  },
]

/**
 * Filter tools based on user permissions.
 */
export function filterToolsByPermissions(
  tools: AITool[],
  availableToolNames: string[],
): AITool[] {
  return tools.filter(t => availableToolNames.includes(t.name))
}

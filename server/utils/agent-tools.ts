import type { StudioTool } from './agent-types'

/**
 * Studio Agent Tool definitions with orchestration metadata.
 *
 * Each tool includes:
 * - requiredPhase: which project phases allow this tool
 * - defaultAffects: what resources this tool typically changes
 * - workflowBehavior: how merge works (auto-merge, review-dependent, manual)
 */

export const STUDIO_TOOLS: StudioTool[] = [
  {
    name: 'list_models',
    description: 'List all content models with their field schemas.',
    inputSchema: { type: 'object', properties: {} },
    requiredPhase: ['uninitialized', 'init_pending', 'active', 'error'],
    defaultAffects: { snapshotChanged: false, branchesChanged: false },
    workflowBehavior: 'none',
  },
  {
    name: 'get_content',
    description: 'Read content entries for a model and locale.',
    inputSchema: {
      type: 'object',
      properties: {
        model: { type: 'string', description: 'Model ID' },
        locale: { type: 'string', description: 'Locale code (default from context)' },
      },
      required: ['model'],
    },
    requiredPhase: ['active'],
    defaultAffects: { snapshotChanged: false, branchesChanged: false },
    workflowBehavior: 'none',
  },
  {
    name: 'save_content',
    description: 'Save content entries. For collections: { entryId: { fields } }. For singletons: { field: value }.',
    inputSchema: {
      type: 'object',
      properties: {
        model: { type: 'string', description: 'Model ID' },
        locale: { type: 'string', description: 'Locale code' },
        data: { type: 'object', description: 'Content data' },
      },
      required: ['model', 'data'],
    },
    requiredPhase: ['active'],
    defaultAffects: { snapshotChanged: false, branchesChanged: true },
    workflowBehavior: 'workflow-dependent',
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
    requiredPhase: ['active'],
    defaultAffects: { snapshotChanged: false, branchesChanged: true },
    workflowBehavior: 'workflow-dependent',
  },
  {
    name: 'save_model',
    description: 'Create or update a model definition.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Model ID (kebab-case)' },
        name: { type: 'string', description: 'Display name' },
        kind: { type: 'string', enum: ['singleton', 'collection', 'document', 'dictionary'] },
        domain: { type: 'string', description: 'Content domain' },
        i18n: { type: 'boolean' },
        fields: { type: 'object', description: '{ fieldId: { type, required?, ... } }' },
      },
      required: ['id', 'name', 'kind', 'domain'],
    },
    requiredPhase: ['active'],
    defaultAffects: { snapshotChanged: true, branchesChanged: true },
    workflowBehavior: 'workflow-dependent',
  },
  {
    name: 'validate',
    description: 'Run validation on content against model schemas.',
    inputSchema: {
      type: 'object',
      properties: {
        model: { type: 'string', description: 'Model ID (optional)' },
        locale: { type: 'string', description: 'Locale (optional)' },
      },
    },
    requiredPhase: ['active', 'uninitialized', 'init_pending', 'error'],
    defaultAffects: { snapshotChanged: false, branchesChanged: false },
    workflowBehavior: 'none',
  },
  {
    name: 'list_branches',
    description: 'List pending contentrain/* branches.',
    inputSchema: { type: 'object', properties: {} },
    requiredPhase: ['active', 'init_pending', 'error'],
    defaultAffects: { snapshotChanged: false, branchesChanged: false },
    workflowBehavior: 'none',
  },
  {
    name: 'merge_branch',
    description: 'Approve and merge a content branch into the default branch.',
    inputSchema: {
      type: 'object',
      properties: { branch: { type: 'string', description: 'Branch name' } },
      required: ['branch'],
    },
    requiredPhase: ['active', 'init_pending'],
    defaultAffects: { snapshotChanged: true, branchesChanged: true },
    workflowBehavior: 'manual',
  },
  {
    name: 'reject_branch',
    description: 'Reject and delete a content branch.',
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
    description: 'Initialize .contentrain/ structure. Creates config, models, and content files.',
    inputSchema: {
      type: 'object',
      properties: {
        stack: { type: 'string', description: 'Framework (nuxt, next, astro, etc.)' },
        locales: { type: 'array', items: { type: 'string' }, description: 'Locale codes' },
        domains: { type: 'array', items: { type: 'string' }, description: 'Content domains' },
        models: {
          type: 'array',
          description: 'Initial models',
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
    workflowBehavior: 'auto-merge', // init always auto-merges
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

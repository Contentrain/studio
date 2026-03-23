import type { ModelDefinition, ContentrainConfig, FieldDef } from '@contentrain/types'
import type { Branch } from '../providers/git'
import type { AgentPermissions } from './agent-permissions'
import type { ChatUIContext, ClassifiedIntent, ProjectPhase } from './agent-types'

/**
 * Bounded Task Executor system prompt.
 *
 * Structure: Role → Contentrain Architecture → UI Context → Intent → State → Schema → Permissions → Rules
 * Each section is purpose-built to constrain the agent's behavior.
 */

export interface ProjectState {
  initialized: boolean
  pendingBranches: Branch[]
  projectStatus: string
  phase: ProjectPhase
  /** .contentrain/context.json — last operation, stats */
  contentContext?: Record<string, unknown> | null
}

export function buildSystemPrompt(
  config: ContentrainConfig | null,
  models: ModelDefinition[],
  permissions: AgentPermissions,
  state: ProjectState,
  uiContext: ChatUIContext,
  intent: ClassifiedIntent,
  vocabulary?: Record<string, Record<string, string>> | null,
  plan?: import('./license').Plan,
): string {
  const sections: string[] = []

  // 1. ROLE — strict, bounded
  sections.push(`You are a Contentrain content management executor. You perform structured content operations on this Git-backed repository using the tools provided.

CONSTRAINTS:
- Execute content tasks using tools. Never output raw JSON for users to copy.
- Do NOT explain what Contentrain is or how it works.
- Do NOT have general knowledge conversations.
- Respond in the user's language. Be concise — 1-2 sentences for confirmations.
- If a request is outside content management, respond with ONE sentence redirecting to content tasks.`)

  // 2. CONTENTRAIN ARCHITECTURE — the agent must know this to work correctly
  sections.push(buildArchitectureSection())

  // 3. UI CONTEXT — what the user is looking at RIGHT NOW
  sections.push(buildContextSection(uiContext, models, config))

  // 4. INFERRED INTENT
  if (intent.category !== 'out_of_scope') {
    const inferredLines: string[] = [`## Inferred Intent: ${intent.category}`]
    if (intent.inferred.modelId) inferredLines.push(`Default model: ${intent.inferred.modelId}`)
    if (intent.inferred.locale) inferredLines.push(`Default locale: ${intent.inferred.locale}`)
    if (intent.inferred.entryId) inferredLines.push(`Default entry: ${intent.inferred.entryId}`)
    if (intent.confidence === 'high') {
      inferredLines.push('Use these defaults unless the user explicitly specifies different values.')
    }
    sections.push(inferredLines.join('\n'))
  }

  // 5. PROJECT STATE
  const stateLines: string[] = ['## Project State']
  stateLines.push(`- Phase: ${state.phase}`)
  stateLines.push(`- Initialized: ${state.initialized ? 'YES' : 'NO'}`)

  if (state.pendingBranches.length > 0) {
    stateLines.push(`- Pending branches (${state.pendingBranches.length}):`)
    for (const b of state.pendingBranches.slice(0, 5)) {
      stateLines.push(`  - ${b.name}`)
    }
  }

  // Context.json — last operation tracking
  if (state.contentContext) {
    const lastOp = state.contentContext.lastOperation as { tool?: string, model?: string, locale?: string, timestamp?: string } | undefined
    const stats = state.contentContext.stats as { models?: number, entries?: number, locales?: string[] } | undefined
    if (lastOp?.tool) {
      stateLines.push(`- Last operation: ${lastOp.tool}${lastOp.model ? ` on ${lastOp.model}` : ''}${lastOp.locale ? ` [${lastOp.locale}]` : ''}`)
    }
    if (stats) {
      stateLines.push(`- Content stats: ${stats.models ?? 0} models, ${stats.entries ?? 0} entries, ${(stats.locales ?? []).length} locales`)
    }
  }

  if (state.phase === 'uninitialized') {
    stateLines.push('\nThis project needs initialization. Use init_project to create .contentrain/ structure.')
  }
  else if (state.phase === 'init_pending') {
    stateLines.push('\nAn init branch exists. Merge it before performing content operations.')
  }

  sections.push(stateLines.join('\n'))

  // 6. PROJECT CONFIG
  if (config) {
    sections.push(`## Configuration
- Stack: ${config.stack}
- Locales: ${config.locales.supported.join(', ')} (default: ${config.locales.default})
- Domains: ${config.domains.join(', ')}
- Workflow: ${config.workflow}`)
  }

  // 7. SCHEMA — full detail for all models with relation graph
  if (models.length > 0) {
    sections.push(buildSchemaSection(models, uiContext))
  }

  // 8. RELATION GRAPH — cross-model references
  const relationGraph = buildRelationGraph(models)
  if (relationGraph) {
    sections.push(relationGraph)
  }

  // 9. VOCABULARY — shared terminology across locales
  if (vocabulary && Object.keys(vocabulary).length > 0) {
    const termCount = Object.keys(vocabulary).length
    const sampleTerms = Object.entries(vocabulary).slice(0, 10)
    const termLines = sampleTerms.map(([key, translations]) => {
      const locales = Object.entries(translations).map(([l, v]) => `${l}: "${v}"`).join(', ')
      return `  - ${key}: ${locales}`
    })
    let vocabSection = `## Vocabulary (${termCount} terms)\nShared terminology from .contentrain/vocabulary.json:\n${termLines.join('\n')}`
    if (termCount > 10) {
      vocabSection += `\n  ... and ${termCount - 10} more terms`
    }
    sections.push(vocabSection)
  }

  // 9. PERMISSIONS
  const roleDisplay = permissions.projectRole
    ? `${permissions.workspaceRole} / ${permissions.projectRole}`
    : permissions.workspaceRole

  sections.push(`## Permissions
- Role: ${roleDisplay}
- Available tools: ${permissions.availableTools.join(', ')}${
  permissions.specificModels
    ? `\n- Model access restricted to: ${permissions.allowedModels.join(', ')}`
    : ''
}`)

  // 10. RULES — hardened, workflow-aware, architecture-aware, role-aware, plan-aware
  sections.push(buildRulesSection(config, intent, permissions, plan))

  return sections.join('\n\n')
}

// ─── Architecture Section ───

function buildArchitectureSection(): string {
  return `## Contentrain Architecture

### Four Content Kinds
| Kind | Storage | Entries | ID | Use Case |
|---|---|---|---|---|
| singleton | JSON object | 1 per locale | model = identity | Hero, nav, config |
| collection | JSON object-map (ID→data) | N per locale | 12-char hex auto-generated | Blog, products, team, FAQ |
| document | Markdown + YAML frontmatter | N (each = directory) | slug (URL-safe) | Blog posts, docs |
| dictionary | JSON flat key-value | Free key-value | key = identity | Error messages, UI strings |

### 27 Field Types
**String:** string, text, email, url, slug, color, phone, code, icon
**Rich text:** markdown, richtext
**Number:** number, integer, decimal, percent, rating (1-5)
**Primitive:** boolean, date (YYYY-MM-DD), datetime (ISO 8601)
**Media:** image, video, file — all store relative path (string), NO upload
**Relation:** relation (single ref → entry ID or slug), relations (array of refs)
**Structural:** select (enum from options[]), array (items), object (nested fields)

### Field Properties
- \`required\`: field must be present
- \`unique\`: value must be unique across entries (collection)
- \`min/max\`: string length, number range, or array size
- \`pattern\`: regex validation
- \`options\`: enum values for select type
- \`model\`: target model ID(s) for relation/relations — string or string[]
- \`items\`: array item type (string type name or FieldDef object)
- \`fields\`: nested fields for object type (max 2 levels deep)
- \`default\`: default value (omitted from storage when matches)
- \`accept\`: MIME types for media fields
- \`description\`: field documentation

### Relation System
- \`relation\` → stores single entry ID (collection target) or slug (document target)
- \`relations\` → stores string[] of IDs/slugs
- Polymorphic: when \`model\` is string[], value is \`{ model: "target-model", ref: "id-or-slug" }\`
- Self-referencing allowed: model can reference itself (e.g., categories.parent → categories)
- Singletons and dictionaries CANNOT be relation targets

### Localization Rules
- \`i18n: true\` → separate file per locale: en.json, tr.json
- \`i18n: false\` → single file: data.json
- Collections: ALL locales must have the SAME entry ID set
- Dictionaries: ALL locales should have the SAME key set
- Entry IDs and slugs are locale-agnostic (same across all locales)

### System Fields (auto-managed, never set manually)
- \`id\`: collection entry ID (12-char hex) — the object-map key
- \`slug\`: document identifier — the directory name
- \`status\`: draft | in_review | published | rejected | archived (in meta file)
- \`source\`: agent | human | import (in meta file)
- \`updated_by\`: who made the last change (in meta file)
- Temporal data: createdAt/updatedAt from git history

### Content Storage Format
- Collections: \`{ "entryId": { field: value, ... }, ... }\` — keys sorted lexicographically
- Singletons: \`{ field: value, ... }\`
- Dictionaries: \`{ "key": "value", ... }\` — all values are strings
- Documents: Markdown with YAML frontmatter (slug, fields in frontmatter, body in markdown)
- Canonical JSON: 2-space indent, sorted keys, omit null/defaults, trailing newline`
}

// ─── Schema Section ───

function buildSchemaSection(models: ModelDefinition[], uiContext: ChatUIContext): string {
  const activeModel = uiContext.activeModelId
    ? models.find(m => m.id === uiContext.activeModelId)
    : null

  const lines: string[] = ['## Content Schema']

  // Show ALL models with full field details (not just active one)
  for (const model of models) {
    const isActive = model.id === activeModel?.id
    const prefix = isActive ? '### ▶ ' : '### '

    lines.push(`${prefix}${model.name} (\`${model.id}\`)`)
    lines.push(`Kind: ${model.kind}, domain: ${model.domain}, i18n: ${model.i18n}`)

    if (model.fields && Object.keys(model.fields).length > 0) {
      const fieldLines = Object.entries(model.fields).map(([id, def]) =>
        `  - ${id}: ${formatFieldDef(def)}`,
      )
      lines.push(`Fields:\n${fieldLines.join('\n')}`)
    }
    else if (model.kind === 'dictionary') {
      lines.push('Fields: none (free key-value, all string values)')
    }

    lines.push('')
  }

  return lines.join('\n')
}

/** Format a field definition with all constraints for the system prompt */
function formatFieldDef(def: FieldDef, depth: number = 0): string {
  const parts: string[] = [def.type]
  const flags: string[] = []

  if (def.required) flags.push('required')
  if (def.unique) flags.push('unique')
  if (def.min !== undefined) flags.push(`min: ${def.min}`)
  if (def.max !== undefined) flags.push(`max: ${def.max}`)
  if (def.pattern) flags.push(`pattern: ${def.pattern}`)
  if (def.default !== undefined) flags.push(`default: ${JSON.stringify(def.default)}`)
  if (def.description) flags.push(`"${def.description}"`)

  // Relation target
  if (def.model) {
    const target = Array.isArray(def.model) ? def.model.join(' | ') : def.model
    flags.push(`→ ${target}`)
  }

  // Select options
  if (def.options) {
    flags.push(`options: [${def.options.join(', ')}]`)
  }

  // Array items
  if (def.items) {
    if (typeof def.items === 'string') {
      flags.push(`items: ${def.items}`)
    }
    else {
      flags.push(`items: ${formatFieldDef(def.items, depth + 1)}`)
    }
  }

  // Media
  if (def.accept) flags.push(`accept: ${def.accept}`)

  if (flags.length > 0) {
    parts.push(`(${flags.join(', ')})`)
  }

  // Nested object fields
  if (def.fields && depth < 2) {
    const nested = Object.entries(def.fields).map(([id, nestedDef]) =>
      `${'    '.repeat(depth + 1)}- ${id}: ${formatFieldDef(nestedDef, depth + 1)}`,
    ).join('\n')
    return `${parts.join(' ')}\n${nested}`
  }

  return parts.join(' ')
}

// ─── Relation Graph ───

function buildRelationGraph(models: ModelDefinition[]): string | null {
  const edges: string[] = []

  for (const model of models) {
    if (!model.fields) continue
    for (const [fieldId, def] of Object.entries(model.fields)) {
      if (def.type === 'relation' || def.type === 'relations') {
        const targets = Array.isArray(def.model) ? def.model : (def.model ? [def.model] : [])
        const cardinality = def.type === 'relation' ? 'one' : 'many'
        for (const target of targets) {
          const targetModel = models.find(m => m.id === target)
          const targetKind = targetModel?.kind ?? 'unknown'
          const refKey = targetKind === 'document' ? 'slug' : 'id'
          edges.push(`- ${model.id}.${fieldId} → ${target} (${cardinality}, ref by ${refKey})`)
        }
      }
    }
  }

  if (edges.length === 0) return null

  return `## Relation Graph\n${edges.join('\n')}\n\nWhen creating/updating relation fields, use existing entry IDs or slugs from the target model. Call get_content on the target model first if you need to look up valid references.`
}

// ─── Context Section ───

function buildContextSection(
  uiContext: ChatUIContext,
  models: ModelDefinition[],
  _config: ContentrainConfig | null,
): string {
  const lines: string[] = ['## UI Context']

  if (uiContext.activeModelId) {
    const model = models.find(m => m.id === uiContext.activeModelId)
    if (model) {
      lines.push(`User is viewing: "${model.name}" (${model.kind}), locale: ${uiContext.activeLocale}`)
      if (uiContext.activeEntryId) {
        lines.push(`Selected entry: ${uiContext.activeEntryId}`)
      }
      lines.push('Do NOT ask which model or locale — use these defaults.')
    }
  }
  else {
    lines.push('User is viewing the project overview (model list).')
  }

  if (uiContext.panelState === 'branch' && uiContext.activeBranch) {
    lines.push(`The user is reviewing branch: ${uiContext.activeBranch}`)
  }

  if (uiContext.panelState === 'vocabulary') {
    lines.push('The user is viewing the vocabulary panel. They may want to add, edit, or discuss terminology.')
  }

  // Pinned context items
  if (uiContext.contextItems && uiContext.contextItems.length > 0) {
    lines.push('')
    lines.push('### Pinned Context')
    lines.push('The user has pinned these items. Use them as primary targets:')
    for (const item of uiContext.contextItems) {
      switch (item.type) {
        case 'model':
          lines.push(`- Model: ${item.modelName ?? item.modelId}`)
          break
        case 'entry':
          lines.push(`- Entry "${item.entryId}" from ${item.modelName ?? item.modelId}${item.data ? `: ${JSON.stringify(item.data).substring(0, 200)}` : ''}`)
          break
        case 'field':
          lines.push(`- Field "${item.fieldId}" from ${item.modelName ?? item.modelId}${item.entryId ? ` (entry: ${item.entryId})` : ''} = ${JSON.stringify(item.data).substring(0, 200)}`)
          break
      }
    }
  }

  return lines.join('\n')
}

// ─── Rules Section ───

function buildRulesSection(config: ContentrainConfig | null, intent: ClassifiedIntent, permissions: AgentPermissions, plan?: import('./license').Plan): string {
  const effectivePlan = plan ?? 'free'
  const workflow = config?.workflow ?? 'auto-merge'
  const isPrivileged = permissions.workspaceRole === 'owner' || permissions.workspaceRole === 'admin'

  const rules = [
    // Context inference
    'Use the inferred model/locale/entry from context unless user explicitly overrides.',
    'Never ask questions you can infer from context.',
    'Never repeat tool calls that already returned results in this conversation.',

    // Content creation
    'For NEW collection entries, generate entry IDs as 12-character lowercase hex strings (e.g., a1b2c3d4e5f6).',
    'For NEW document entries, generate a slug from the title (kebab-case, lowercase, alphanumeric + hyphens).',
    'Dictionary entries are free key-value pairs — ALL values must be strings.',

    // Content updates
    'To UPDATE existing content, use the EXISTING entry ID from get_content. NEVER generate a new ID for updates — this causes duplicates.',
    'save_content MERGES with existing data. Only send the fields that changed, not all fields.',

    // Relations
    'For relation fields, the value must be an existing entry ID (for collection targets) or slug (for document targets) from the target model.',
    'For polymorphic relations (model is string[]), store as { "model": "target-model", "ref": "id-or-slug" }.',
    'Before setting a relation value, verify the target entry exists by calling get_content on the target model.',

    // Validation
    'Respect field constraints: required fields must be present, unique values must not duplicate, min/max bounds enforced.',
    'For select fields, value MUST be one of the defined options.',

    // i18n
    'When creating collection entries in i18n models, the same entry ID must exist in ALL supported locales.',
    'When creating dictionary entries in i18n models, the same keys should exist in ALL supported locales.',

    // Serialization
    'Sort object keys alphabetically. Omit null values and default values.',
    'System fields (id, slug, status, source, updated_by) are auto-managed — NEVER include them in content data.',
  ]

  // Workflow + role rules
  if (workflow === 'auto-merge') {
    rules.push('After save_content/save_model/init_project, changes are auto-merged. Report the result directly.')
  }
  else if (isPrivileged) {
    rules.push('After save_content/save_model, changes are auto-merged (you have admin/owner privileges). Report the result directly.')
  }
  else {
    rules.push('After save_content/save_model, a review branch is created. Tell the user which branch was created and that it needs approval from a reviewer or admin.')
    rules.push('Do NOT call merge_branch automatically. Wait for a reviewer/admin to approve.')
  }

  // Plan-aware rules
  if (effectivePlan === 'free') {
    rules.push('This workspace is on the FREE plan. All content changes auto-merge immediately. Review workflow, reviewer/viewer roles, and BYOA API keys are not available.')
  }

  // Out of scope
  if (intent.category === 'out_of_scope') {
    rules.push('This message appears off-topic. Respond with ONE sentence redirecting to content management tasks.')
  }

  return `## Rules\n${rules.map(r => `- ${r}`).join('\n')}`
}

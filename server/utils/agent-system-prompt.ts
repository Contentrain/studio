import type { ModelDefinition, ContentrainConfig, FieldDef } from '@contentrain/types'
import type { AISystemBlock } from '../providers/ai'
import type { Branch } from '../providers/git'
import type { AgentPermissions } from './agent-permissions'
import type { ChatUIContext, ClassifiedIntent, ProjectPhase } from './agent-types'
import { extractMediaStoragePath } from './media-rewrite'

/**
 * Bounded Task Executor system prompt.
 *
 * Two ways to consume:
 *
 *   - `buildSystemPrompt(...)` returns a single concatenated string,
 *     preserved for callers that don't want prompt-cache markers
 *     (legacy paths, tests, alternative providers).
 *
 *   - `buildSystemPromptBlocks(...)` returns a `static` /
 *     `contentIndex` / `dynamic` split shaped for Anthropic's
 *     `cache_control` breakpoints. The caller assembles the final
 *     `AISystemBlock[]` and places markers on the first two blocks.
 *
 * Static/dynamic split rule: a section is "static" only if its
 * content is byte-identical across requests within the same project
 * (modulo brain refreshes). Anything keyed on `uiContext`, `intent`,
 * or `state` lives in the dynamic block so a single-character change
 * doesn't invalidate the cached prefix.
 */

export interface ProjectState {
  initialized: boolean
  pendingBranches: Branch[]
  projectStatus: string
  phase: ProjectPhase
  /** .contentrain/context.json — last operation, stats */
  contentContext?: Record<string, unknown> | null
}

/**
 * Static prompt body — content that does NOT vary with `uiContext`,
 * `intent`, or `state`. Safe to wrap in a cached system block.
 */
function buildStaticBody(
  config: ContentrainConfig | null,
  models: ModelDefinition[],
  permissions: AgentPermissions,
  vocabulary?: Record<string, Record<string, string>> | null,
  plan?: import('./license').Plan,
  customInstructions?: string | null,
  edition?: 'agpl' | 'ee',
): string {
  const sections: string[] = []

  // ROLE
  sections.push(agentPrompt('role.definition'))

  // CONTENTRAIN ARCHITECTURE
  sections.push(buildArchitectureSection())

  // CONFIG
  if (config) {
    sections.push(`## Configuration
- Stack: ${config.stack}
- Locales: ${config.locales.supported.join(', ')} (default: ${config.locales.default})
- Domains: ${config.domains.join(', ')}
- Workflow: ${config.workflow}`)
  }

  // SCHEMA — model list without active-model marker
  if (models.length > 0) {
    sections.push(buildSchemaSection(models))
  }

  // RELATION GRAPH
  const relationGraph = buildRelationGraph(models)
  if (relationGraph) {
    sections.push(relationGraph)
  }

  // VOCABULARY
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

  // PERMISSIONS
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

  // ROLE CAPABILITIES — what each role may do, so the agent sets correct
  // expectations (e.g. a Viewer) before hitting a permission wall.
  sections.push(agentPrompt('permissions.role_capabilities'))

  // BASE RULES — intent-independent
  sections.push(buildBaseRulesSection(config, permissions, plan, edition))

  // CUSTOM INSTRUCTIONS (per Conversation API key, stable across the key's lifetime)
  if (customInstructions) {
    sections.push(`### Custom Instructions (from project admin)\n${customInstructions}`)
  }

  return sections.join('\n\n')
}

/**
 * Dynamic prompt body — UI context, intent, state, intent-specific
 * rules. Anything that changes per request lives here so the cache
 * marker on the static block stays valid.
 */
/** Minimal shape of an attachment summary (avoids importing the heavy
 * attachment-ingest module into the prompt builder). */
export interface PromptAttachment {
  kind: 'text' | 'document' | 'image'
  filename: string
  url?: string
}

function buildAttachmentSection(attachments: PromptAttachment[]): string {
  const lines: string[] = [
    '## Attached sources (this message)',
    'The user attached the following sources to THIS message. Treat them as source material for the requested content.',
  ]
  for (const a of attachments) {
    if (a.kind === 'image' && a.url) {
      const storagePath = extractMediaStoragePath(a.url)
      lines.push(`- ${a.filename} (image — already uploaded to the media library at ${a.url}${storagePath ? `, storage path ${storagePath}` : ''}. Reuse this URL directly in image/media fields; do NOT call upload_media for it.)`)
    }
    else if (a.kind === 'image') {
      lines.push(`- ${a.filename} (image, included in this message for you to view — ephemeral, NOT in the media library; it has no URL or path to reference in content, so never invent one)`)
    }
    else if (a.kind === 'document') {
      lines.push(`- ${a.filename} (PDF document, included in this message)`)
    }
    else {
      lines.push(`- ${a.filename} (text content extracted and included in this message)`)
    }
  }
  return lines.join('\n')
}

function buildDynamicBody(
  models: ModelDefinition[],
  state: ProjectState,
  uiContext: ChatUIContext,
  intent: ClassifiedIntent,
  config: ContentrainConfig | null,
  attachments?: PromptAttachment[],
): string {
  const sections: string[] = []

  // ATTACHED SOURCES — files/links the user added to this message
  if (attachments && attachments.length > 0) {
    sections.push(buildAttachmentSection(attachments))
  }

  // UI CONTEXT — what the user is looking at RIGHT NOW (includes active model annotation)
  sections.push(buildContextSection(uiContext, models, config))

  // INFERRED INTENT
  if (intent.category !== 'out_of_scope') {
    const inferredLines: string[] = [`## Inferred Intent: ${intent.category}`]
    if (intent.inferred.modelId) inferredLines.push(`Default model: ${intent.inferred.modelId}`)
    if (intent.inferred.locale) inferredLines.push(`Default locale: ${intent.inferred.locale}`)
    if (intent.inferred.entryId) inferredLines.push(`Default entry: ${intent.inferred.entryId}`)
    if (intent.confidence === 'high') {
      inferredLines.push(agentPrompt('intent.use_defaults'))
    }
    sections.push(inferredLines.join('\n'))
  }

  // PROJECT STATE
  const stateLines: string[] = ['## Project State']
  stateLines.push(`- Phase: ${state.phase}`)
  stateLines.push(`- Initialized: ${state.initialized ? 'YES' : 'NO'}`)

  if (state.pendingBranches.length > 0) {
    stateLines.push(`- Pending branches (${state.pendingBranches.length}):`)
    for (const b of state.pendingBranches.slice(0, 5)) {
      stateLines.push(`  - ${b.name}`)
    }
  }

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
    stateLines.push(`\n${agentPrompt('state.needs_init')}`)
  }
  else if (state.phase === 'init_pending') {
    stateLines.push(`\n${agentPrompt('state.init_branch_exists')}`)
  }

  sections.push(stateLines.join('\n'))

  // INTENT-SPECIFIC RULES (out-of-scope, etc.)
  const intentRules = buildIntentRulesSection(intent)
  if (intentRules) sections.push(intentRules)

  return sections.join('\n\n')
}

/**
 * Structured system prompt split into prompt-cache friendly blocks.
 *
 * - `static`: stable across requests; safe behind a `cache_control`
 *   marker (Block 1).
 * - `contentIndex`: brain content index, refreshes on its own TTL;
 *   gets its own cache breakpoint (Block 2) so a schema change
 *   doesn't invalidate the content cache and vice versa.
 * - `dynamic`: UI context / intent / state — must come after the
 *   cache breakpoints so request-by-request changes don't break the
 *   cached prefix.
 *
 * Callers compose `AISystemBlock[]` and place markers on the first
 * two blocks. The `contentIndex` field is `null` when the brain
 * hasn't produced one.
 */
export interface SystemPromptBlocks {
  static: string
  contentIndex: string | null
  dynamic: string
}

export function buildSystemPromptBlocks(
  config: ContentrainConfig | null,
  models: ModelDefinition[],
  permissions: AgentPermissions,
  state: ProjectState,
  uiContext: ChatUIContext,
  intent: ClassifiedIntent,
  contentIndex: string | null,
  vocabulary?: Record<string, Record<string, string>> | null,
  plan?: import('./license').Plan,
  customInstructions?: string | null,
  attachments?: PromptAttachment[],
  edition?: 'agpl' | 'ee',
): SystemPromptBlocks {
  return {
    static: buildStaticBody(config, models, permissions, vocabulary, plan, customInstructions, edition),
    contentIndex: contentIndex && contentIndex.trim() ? contentIndex : null,
    dynamic: buildDynamicBody(models, state, uiContext, intent, config, attachments),
  }
}

/**
 * Materialize the cache-aware blocks as an `AISystemBlock[]` ready
 * to hand to `AIProvider`. The first two blocks (static + brain
 * content index) get `cache_control` markers; the dynamic block
 * stays uncached so request-level changes don't poison the prefix.
 */
export function toSystemBlocks(prompt: SystemPromptBlocks): AISystemBlock[] {
  const blocks: AISystemBlock[] = []
  blocks.push({ type: 'text', text: prompt.static, cacheControl: { type: 'ephemeral' } })
  if (prompt.contentIndex) {
    blocks.push({ type: 'text', text: prompt.contentIndex, cacheControl: { type: 'ephemeral' } })
  }
  if (prompt.dynamic.trim()) {
    blocks.push({ type: 'text', text: prompt.dynamic })
  }
  return blocks
}

/**
 * Legacy single-string composition, preserved for callers that don't
 * want cache markers (alternative providers, certain test paths).
 * Equivalent to `buildSystemPromptBlocks(...)` concatenated, no
 * cache_control markers — semantically identical to the old function.
 */
export function buildSystemPrompt(
  config: ContentrainConfig | null,
  models: ModelDefinition[],
  permissions: AgentPermissions,
  state: ProjectState,
  uiContext: ChatUIContext,
  intent: ClassifiedIntent,
  vocabulary?: Record<string, Record<string, string>> | null,
  plan?: import('./license').Plan,
  customInstructions?: string | null,
): string {
  const blocks = buildSystemPromptBlocks(
    config, models, permissions, state, uiContext, intent,
    null, // contentIndex appended by caller via `${prompt}\n\n${contentIndex}`
    vocabulary, plan, customInstructions,
  )
  return [blocks.static, blocks.dynamic].filter(Boolean).join('\n\n')
}

// ─── Architecture Section ───

function buildArchitectureSection(): string {
  return [
    agentPrompt('architecture.intro'),
    agentPrompt('architecture.content_kinds'),
    agentPrompt('architecture.field_types', { mediaFieldGuide: agentPrompt('media.field_guide') }),
    agentPrompt('architecture.field_properties'),
    agentPrompt('architecture.relations'),
    agentPrompt('architecture.localization'),
    agentPrompt('architecture.system_fields'),
    agentPrompt('architecture.storage_format'),
    agentPrompt('architecture.branch_model'),
    agentPrompt('architecture.branch_health'),
    agentPrompt('architecture.markdown_authoring'),
  ].join('\n\n')
}

// ─── Schema Section ───

/**
 * Pure model-list rendering — no active-model marker. The active
 * model annotation lives in the dynamic UI Context block so the
 * schema itself stays byte-identical across requests and the
 * cache_control marker placed on the static system block can
 * actually hit.
 */
function buildSchemaSection(models: ModelDefinition[]): string {
  const lines: string[] = ['## Content Schema']

  for (const model of models) {
    lines.push(`### ${model.name} (\`${model.id}\`)`)
    lines.push(`Kind: ${model.kind}, domain: ${model.domain}, i18n: ${model.i18n}`)

    if (model.fields && Object.keys(model.fields).length > 0) {
      const fieldLines = Object.entries(model.fields).map(([id, def]) =>
        `  - ${id}: ${formatFieldDef(def)}`,
      )
      lines.push(`Fields:\n${fieldLines.join('\n')}`)
    }
    else if (model.kind === 'dictionary') {
      lines.push(agentPrompt('architecture.dictionary_fields'))
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

  // At the depth cap, still NAME the subfields. Dropping them entirely made
  // the schema summary claim e.g. `cards: array (items: object)` with no
  // hint an `image` existed — and the agent answered "this content cannot
  // be managed here" without ever querying it.
  if (def.fields) {
    parts.push(`{${Object.keys(def.fields).join(', ')}}`)
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

  return `## Relation Graph\n${edges.join('\n')}\n\n${agentPrompt('rules.relation_graph_hint')}`
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
      lines.push(agentPrompt('context.viewing_model', { name: model.name, kind: model.kind, locale: uiContext.activeLocale }))
      if (uiContext.activeEntryId) {
        lines.push(agentPrompt('context.selected_entry', { entryId: uiContext.activeEntryId }))
      }
      lines.push(agentPrompt('context.use_defaults'))
    }
  }
  else {
    lines.push(agentPrompt('context.project_overview'))
  }

  if (uiContext.panelState === 'branch' && uiContext.activeBranch) {
    lines.push(agentPrompt('context.reviewing_branch', { branch: uiContext.activeBranch }))
  }

  if (uiContext.panelState === 'vocabulary') {
    lines.push(agentPrompt('context.vocabulary_panel'))
  }

  // Pinned context items
  if (uiContext.contextItems && uiContext.contextItems.length > 0) {
    lines.push('')
    lines.push(agentPrompt('context.pinned_header'))
    lines.push(agentPrompt('context.pinned_instruction'))
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
        case 'asset': {
          const assetData = item.data as Record<string, unknown> | undefined
          const assetPath = assetData?.originalPath ?? assetData?.path ?? item.assetId
          const assetInfo = assetData ? ` (${assetData.format ?? 'file'}, ${assetData.width ?? '?'}×${assetData.height ?? '?'})` : ''
          lines.push(`- Asset: ${assetData?.filename ?? item.assetId}${assetInfo} → path: ${assetPath}`)
          break
        }
      }
    }
  }

  return lines.join('\n')
}

// ─── Rules Section ───

/**
 * Base rules block — depends on `config` (project-stable),
 * `permissions` (role-stable per request), and `plan` (workspace-
 * stable). No intent dependency, so safe for the cached prefix.
 */
function buildBaseRulesSection(config: ContentrainConfig | null, permissions: AgentPermissions, plan?: import('./license').Plan, edition?: 'agpl' | 'ee'): string {
  const effectivePlan = plan ?? 'starter'
  const workflow = config?.workflow ?? 'auto-merge'
  const isPrivileged = permissions.workspaceRole === 'owner' || permissions.workspaceRole === 'admin'

  const rules = [
    // Context inference
    agentPrompt('rules.context_infer'),
    agentPrompt('rules.context_no_ask'),
    agentPrompt('rules.context_no_repeat'),

    // Content creation
    agentPrompt('rules.collection_id'),
    agentPrompt('rules.document_slug'),
    agentPrompt('rules.dictionary_values'),

    // Content reads — prefer brain cache
    agentPrompt('brain.tools_guide'),

    // Content updates
    agentPrompt('rules.update_existing_id'),
    agentPrompt('rules.update_merge'),

    // Write sizing — keep tool calls under the output-token ceiling
    agentPrompt('rules.batch_writes'),

    // Relations
    agentPrompt('rules.relation_value'),
    agentPrompt('rules.polymorphic_relation'),
    agentPrompt('rules.relation_verify'),

    // Validation
    agentPrompt('rules.validate_constraints'),
    agentPrompt('rules.select_options'),

    // i18n
    agentPrompt('rules.i18n_collection'),
    agentPrompt('rules.i18n_dictionary'),

    // Dictionary models hold user-facing UI copy
    agentPrompt('rules.ui_strings'),

    // Form submissions lifecycle
    agentPrompt('forms.lifecycle'),

    // Serialization
    agentPrompt('rules.serialization_keys'),
    agentPrompt('rules.system_fields'),
  ]

  // Workflow + role rules
  if (workflow === 'auto-merge') {
    rules.push(agentPrompt('rules.auto_merge_owner'))
  }
  else if (isPrivileged) {
    rules.push(agentPrompt('rules.auto_merge_admin'))
  }
  else {
    rules.push(agentPrompt('rules.review_branch'))
    rules.push(agentPrompt('rules.no_auto_merge'))
  }

  // Plan / edition narrative. Edition is orthogonal to plan: in
  // Community Edition (AGPL, no enterprise bridge) the plan-gated EE
  // features (media library, CDN, conversation keys, webhooks, SSO,
  // spam filter, model-specific access) do not exist and there is no
  // purchase path — advertising them or coaching upgrades gives the
  // user a wrong mental model. So suppress all plan/upgrade narrative
  // in Community and emit a single neutral self-host note instead.
  if (edition === 'agpl') {
    rules.push(agentPrompt('plan.community'))
  }
  else {
    // Plan-aware rules — inform agent about available features and guide user
    const planParams = getPlanParams(effectivePlan)
    if (effectivePlan === 'starter') {
      const upgradeParams = getUpgradeParams('starter', 'pro')
      rules.push(agentPrompt('plan.starter', planParams))
      rules.push(agentPrompt('plan.starter.upgrade_hint', upgradeParams))
    }
    else if (effectivePlan === 'pro') {
      rules.push(agentPrompt('plan.pro', planParams))
      rules.push(agentPrompt('plan.pro.upgrade_hint'))
    }
    else if (effectivePlan === 'enterprise') {
      rules.push(agentPrompt('plan.enterprise'))
    }

    // Feature upgrade guidance — when a tool returns a plan-gated error, help the user understand
    rules.push(agentPrompt('upgrade.guidance'))
    const tierParams = {
      starterPrice: PLAN_PRICING.starter.priceMonthly ? `$${PLAN_PRICING.starter.priceMonthly}` : 'free',
      starterSeats: PLAN_PRICING.starter.seatsIncluded,
      proPrice: `$${PLAN_PRICING.pro.priceMonthly}`,
      proSeats: PLAN_PRICING.pro.seatsIncluded,
    }
    rules.push(agentPrompt('plan.tiers', tierParams))
  }

  return `## Rules\n${rules.map(r => `- ${r}`).join('\n')}`
}

/**
 * Intent-dependent rules. Returns `null` when no intent-specific rule
 * applies (the common case), so the caller can omit the section
 * entirely and keep the dynamic block minimal.
 */
function buildIntentRulesSection(intent: ClassifiedIntent): string | null {
  if (intent.category === 'out_of_scope') {
    return `## Additional Rules\n- ${agentPrompt('rules.off_topic')}`
  }
  return null
}

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
  customInstructions?: string | null,
): string {
  const sections: string[] = []

  // 1. ROLE — strict, bounded
  sections.push(agentPrompt('role.definition'))

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
      inferredLines.push(agentPrompt('intent.use_defaults'))
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
    stateLines.push(`\n${agentPrompt('state.needs_init')}`)
  }
  else if (state.phase === 'init_pending') {
    stateLines.push(`\n${agentPrompt('state.init_branch_exists')}`)
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

  // Custom instructions (Conversation API keys)
  if (customInstructions) {
    sections.push(`### Custom Instructions (from project admin)\n${customInstructions}`)
  }

  return sections.join('\n\n')
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
  ].join('\n\n')
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

function buildRulesSection(config: ContentrainConfig | null, intent: ClassifiedIntent, permissions: AgentPermissions, plan?: import('./license').Plan): string {
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

  // Out of scope
  if (intent.category === 'out_of_scope') {
    rules.push(agentPrompt('rules.off_topic'))
  }

  return `## Rules\n${rules.map(r => `- ${r}`).join('\n')}`
}

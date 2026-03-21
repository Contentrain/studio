import type { ModelDefinition, ContentrainConfig } from '@contentrain/types'
import type { Branch } from '../providers/git'
import type { AgentPermissions } from './agent-permissions'
import type { ChatUIContext, ClassifiedIntent, ProjectPhase } from './agent-types'

/**
 * Bounded Task Executor system prompt.
 *
 * Structure: Role → UI Context → Intent → State → Schema → Permissions → Rules
 * Each section is purpose-built to constrain the agent's behavior.
 */

export interface ProjectState {
  initialized: boolean
  pendingBranches: Branch[]
  projectStatus: string
  phase: ProjectPhase
}

export function buildSystemPrompt(
  config: ContentrainConfig | null,
  models: ModelDefinition[],
  permissions: AgentPermissions,
  state: ProjectState,
  uiContext: ChatUIContext,
  intent: ClassifiedIntent,
): string {
  const sections: string[] = []

  // 1. ROLE — strict, bounded
  sections.push(`You are a content management executor. You perform structured content operations on this Git repository using the tools provided.

CONSTRAINTS:
- Execute content tasks using tools. Never output raw JSON for users to copy.
- Do NOT explain what Contentrain is or how it works.
- Do NOT have general knowledge conversations.
- Respond in the user's language. Be concise — 1-2 sentences for confirmations.
- If a request is outside content management, respond with ONE sentence redirecting to content tasks.`)

  // 2. UI CONTEXT — what the user is looking at RIGHT NOW
  sections.push(buildContextSection(uiContext, models, config))

  // 3. INFERRED INTENT
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

  // 4. PROJECT STATE
  const stateLines: string[] = ['## Project State']
  stateLines.push(`- Phase: ${state.phase}`)
  stateLines.push(`- Initialized: ${state.initialized ? 'YES' : 'NO'}`)

  if (state.pendingBranches.length > 0) {
    stateLines.push(`- Pending branches (${state.pendingBranches.length}):`)
    for (const b of state.pendingBranches.slice(0, 5)) {
      stateLines.push(`  - ${b.name}`)
    }
  }

  if (state.phase === 'uninitialized') {
    stateLines.push('\nThis project needs initialization. Use init_project to create .contentrain/ structure.')
  }
  else if (state.phase === 'init_pending') {
    stateLines.push('\nAn init branch exists. Merge it before performing content operations.')
  }

  sections.push(stateLines.join('\n'))

  // 5. PROJECT CONFIG
  if (config) {
    sections.push(`## Configuration
- Stack: ${config.stack}
- Locales: ${config.locales.supported.join(', ')} (default: ${config.locales.default})
- Domains: ${config.domains.join(', ')}
- Workflow: ${config.workflow}`)
  }

  // 6. SCHEMA — only active model in detail, others as summary
  if (models.length > 0) {
    const activeModel = uiContext.activeModelId
      ? models.find(m => m.id === uiContext.activeModelId)
      : null

    if (activeModel && activeModel.fields) {
      const fieldList = Object.entries(activeModel.fields).map(([id, def]) => {
        const flags = [
          def.required ? 'required' : '',
          def.unique ? 'unique' : '',
          def.options ? `options: [${def.options.join(', ')}]` : '',
        ].filter(Boolean).join(', ')
        return `  - ${id}: ${def.type}${flags ? ` (${flags})` : ''}`
      }).join('\n')

      sections.push(`## Active Model: ${activeModel.name}
Kind: ${activeModel.kind}, domain: ${activeModel.domain}, i18n: ${activeModel.i18n}
Fields:
${fieldList}`)

      // Other models as summary
      const others = models.filter(m => m.id !== activeModel.id)
      if (others.length > 0) {
        const summaryList = others.map(m => `  - ${m.id}: ${m.name} (${m.kind})`).join('\n')
        sections.push(`## Other Models\n${summaryList}`)
      }
    }
    else {
      // No active model — show all as summary
      const summaryList = models.map(m => `  - ${m.id}: ${m.name} (${m.kind}, ${Object.keys(m.fields ?? {}).length} fields)`).join('\n')
      sections.push(`## Models\n${summaryList}`)
    }
  }

  // 7. PERMISSIONS
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

  // 8. RULES — hardened, workflow-aware
  const workflow = config?.workflow ?? 'auto-merge'

  const rules = [
    'Use the inferred model/locale/entry from context unless user explicitly overrides.',
    'For NEW collection entries, generate entry IDs as 12-character lowercase hex strings.',
    'To UPDATE existing content, use the EXISTING entry ID from get_content. NEVER generate a new ID for updates — this causes duplicates.',
    'save_content MERGES with existing data. Only send the fields that changed, not all fields.',
    'Sort object keys alphabetically. Omit null values and defaults.',
    'Never ask questions you can infer from context.',
    'Never repeat tool calls that already returned results in this conversation.',
  ]

  if (workflow === 'auto-merge') {
    rules.push('After save_content/save_model/init_project, changes are auto-merged. Report the result directly.')
  }
  else {
    rules.push('After save_content/save_model, a review branch is created. Tell the user which branch to review.')
    rules.push('Do NOT call merge_branch automatically. Wait for user to explicitly approve.')
  }

  if (intent.category === 'out_of_scope') {
    rules.push('This message appears off-topic. Respond with ONE sentence redirecting to content management tasks.')
  }

  sections.push(`## Rules\n${rules.map(r => `- ${r}`).join('\n')}`)

  return sections.join('\n\n')
}

/** Build UI context section (extracted for reuse) */
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

  return lines.join('\n')
}

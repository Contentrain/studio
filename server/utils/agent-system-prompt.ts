import type { ModelDefinition, ContentrainConfig } from '@contentrain/types'
import type { Branch } from '../providers/git'
import type { AgentPermissions } from './agent-permissions'

/**
 * Build the system prompt dynamically per chat request.
 *
 * Includes: role, project state, schema, permissions, rules.
 * Project state (pending branches, init status) prevents the agent
 * from making redundant tool calls or losing context.
 */

export interface ProjectState {
  initialized: boolean
  pendingBranches: Branch[]
  projectStatus: string // 'active' | 'setup' | 'error'
}

export function buildSystemPrompt(
  config: ContentrainConfig | null,
  models: ModelDefinition[],
  permissions: AgentPermissions,
  state: ProjectState,
): string {
  const sections: string[] = []

  // 1. Role definition — concise, no product marketing
  sections.push(`You are a content assistant. You manage structured content in this Git repository using the tools provided.
Use tools for all operations. Every change creates a Git branch, then auto-merge.
Respond in the user's language. Be concise — no unnecessary explanations about what Contentrain is.`)

  // 2. Project state — critical context to prevent redundant actions
  const stateLines: string[] = []
  stateLines.push(`- Contentrain initialized: ${state.initialized ? 'YES' : 'NO'}`)
  stateLines.push(`- Project status: ${state.projectStatus}`)

  if (state.pendingBranches.length > 0) {
    stateLines.push(`- Pending branches (${state.pendingBranches.length}):`)
    for (const b of state.pendingBranches.slice(0, 5)) {
      stateLines.push(`  - ${b.name}`)
    }
  }
  else {
    stateLines.push('- Pending branches: none')
  }

  sections.push(`## Current Project State\n${stateLines.join('\n')}`)

  // 3. Project config
  if (config) {
    sections.push(`## Project Configuration
- Stack: ${config.stack}
- Locales: ${config.locales.supported.join(', ')} (default: ${config.locales.default})
- Domains: ${config.domains.join(', ')}
- Workflow: ${config.workflow}`)
  }
  else if (!state.initialized) {
    sections.push(`## Project Configuration
This project has no .contentrain/ directory yet. Use init_project to create one.
If there are pending init branches, offer to merge them first.`)
  }

  // 4. Models schema
  if (models.length > 0) {
    const modelSummaries = models.map((m) => {
      const fieldList = m.fields
        ? Object.entries(m.fields).map(([id, def]) => {
            const flags = [
              def.required ? 'required' : '',
              def.unique ? 'unique' : '',
            ].filter(Boolean).join(', ')
            return `  - ${id}: ${def.type}${flags ? ` (${flags})` : ''}`
          }).join('\n')
        : '  (no fields — dictionary or schema-less)'

      return `### ${m.name} (${m.kind}, domain: ${m.domain}, i18n: ${m.i18n})
ID: ${m.id}
${fieldList}`
    }).join('\n\n')

    sections.push(`## Content Models\n\n${modelSummaries}`)
  }
  else if (state.initialized) {
    sections.push('## Content Models\nNo models defined yet. Use save_model to create one.')
  }

  // 5. Permissions
  const roleDisplay = permissions.projectRole
    ? `${permissions.workspaceRole} (workspace) / ${permissions.projectRole} (project)`
    : `${permissions.workspaceRole} (workspace)`

  sections.push(`## Your Permissions
- Role: ${roleDisplay}
- Available tools: ${permissions.availableTools.join(', ')}${
  permissions.specificModels
    ? `\n- Model access restricted to: ${permissions.allowedModels.join(', ')}`
    : ''
}`)

  // 6. Rules
  sections.push(`## Rules
- Always use the default locale (${config?.locales.default ?? 'en'}) unless the user specifies another.
- For collections, generate entry IDs as 12-character lowercase hex strings.
- Sort object keys alphabetically in content data.
- Do not include null values or default values in content.
- When creating content, validate all required fields are present.
- After saving content or initializing, IMMEDIATELY call merge_branch to apply the changes.
- Do NOT ask the user to merge manually — merge automatically unless the workflow is "review".
- If there are pending branches from previous operations, offer to merge them.
- Be concise. Don't explain technical details unless asked.
- Never repeat tool calls that already returned results in this conversation.`)

  return sections.join('\n\n')
}

import type { ModelDefinition, ContentrainConfig } from '@contentrain/types'
import type { AgentPermissions } from './agent-permissions'

/**
 * Build the system prompt dynamically per chat request.
 *
 * Includes: role definition, project schema, permissions, rules.
 * The agent uses this context to make informed tool calls.
 */

export function buildSystemPrompt(
  config: ContentrainConfig | null,
  models: ModelDefinition[],
  permissions: AgentPermissions,
): string {
  const sections: string[] = []

  // 1. Role definition
  sections.push(`You are a content management assistant for Contentrain Studio.
You help users create, edit, and manage structured content using the provided tools.
You MUST use tools for all content operations — never output raw JSON for the user to copy.
Every content change creates a Git branch for review.`)

  // 2. Project context
  if (config) {
    sections.push(`## Project
- Stack: ${config.stack}
- Locales: ${config.locales.supported.join(', ')} (default: ${config.locales.default})
- Domains: ${config.domains.join(', ')}
- Workflow: ${config.workflow}`)
  }

  // 3. Models schema
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

  // 4. Permissions
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

  // 5. Rules
  sections.push(`## Rules
- Always use the default locale (${config?.locales.default ?? 'en'}) unless the user specifies another.
- For collections, generate entry IDs as 12-character lowercase hex strings.
- Sort object keys alphabetically in content data.
- Do not include null values or default values in content.
- When creating content, validate all required fields are present.
- When the user asks to translate, use copy_locale or save_content with the target locale.
- After saving, tell the user which branch was created and how to review/merge it.
- Be concise and helpful. Don't explain technical details unless asked.`)

  return sections.join('\n\n')
}

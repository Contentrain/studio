import type { ModelDefinition, ContentrainConfig } from '@contentrain/types'
import type { ChatUIContext, ClassifiedIntent, IntentCategory, ProjectPhase } from './agent-types'

/**
 * Context enrichment — tells the agent what the user is looking at.
 *
 * This is the KEY to eliminating unnecessary clarifying questions.
 * If the user is viewing FAQ in English, the agent should KNOW that
 * without asking.
 */

/** Build the UI context section for the system prompt */
export function buildContextSection(
  uiContext: ChatUIContext,
  models: ModelDefinition[],
  _config: ContentrainConfig | null,
): string {
  const lines: string[] = ['## Current UI Context']

  if (uiContext.activeModelId) {
    const model = models.find(m => m.id === uiContext.activeModelId)
    if (model) {
      lines.push(`The user is viewing the "${model.name}" model (${model.kind}, domain: ${model.domain}, i18n: ${model.i18n}).`)
      lines.push(`Selected locale: ${uiContext.activeLocale}`)
      if (uiContext.activeEntryId) {
        lines.push(`Selected entry: ${uiContext.activeEntryId}`)
      }
      lines.push('')
      lines.push(`When the user says "add entry", "edit", "update", or "create" without specifying a model, they mean the ${model.name} model.`)
      lines.push(`When they don't specify a locale, use ${uiContext.activeLocale}.`)
      lines.push('Do NOT ask which model or locale — use these defaults.')
    }
  }
  else {
    lines.push('The user is viewing the project overview (model list).')
    lines.push('If they ask to add content, ask which model they want to use.')
  }

  if (uiContext.panelState === 'branch' && uiContext.activeBranch) {
    lines.push(`The user is reviewing branch: ${uiContext.activeBranch}`)
  }

  // Pinned context items — user explicitly selected these
  if (uiContext.contextItems && uiContext.contextItems.length > 0) {
    lines.push('')
    lines.push('## Pinned Context')
    lines.push('The user has pinned these items for reference. Use them as primary targets when the user refers to content:')
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

/** Classify intent from message text + UI context */
export function classifyIntent(
  message: string,
  uiContext: ChatUIContext,
  _phase: ProjectPhase,
): ClassifiedIntent {
  const lower = message.toLowerCase()

  // Intent patterns (ordered by specificity)
  const patterns: Array<{ category: IntentCategory, keywords: string[] }> = [
    { category: 'project_operation', keywords: ['init', 'initialize', 'başlat', 'kur', 'setup', 'configure', 'yapılandır'] },
    { category: 'branch_operation', keywords: ['merge', 'approve', 'reject', 'onayla', 'reddet', 'branch', 'birleştir'] },
    { category: 'model_operation', keywords: ['model oluştur', 'create model', 'add model', 'new model', 'field ekle', 'add field', 'alan ekle', 'model tanımla'] },
    { category: 'content_operation', keywords: ['ekle', 'add', 'create', 'oluştur', 'edit', 'update', 'düzenle', 'güncelle', 'delete', 'sil', 'remove', 'kaldır', 'translate', 'çevir', 'entry', 'içerik'] },
    { category: 'query', keywords: ['list', 'show', 'göster', 'what', 'how', 'ne', 'nasıl', 'kaç', 'how many', 'get', 'al'] },
  ]

  let category: IntentCategory = 'out_of_scope'
  let confidence: 'high' | 'medium' | 'low' = 'low'

  for (const pattern of patterns) {
    if (pattern.keywords.some(kw => lower.includes(kw))) {
      category = pattern.category
      confidence = 'high'
      break
    }
  }

  // If no keyword match but we have active model context, it's likely content_operation
  if (category === 'out_of_scope' && uiContext.activeModelId && lower.length > 3) {
    category = 'content_operation'
    confidence = 'medium'
  }

  // Greeting/short messages in active context → query
  if (category === 'out_of_scope' && lower.length < 20) {
    category = 'query'
    confidence = 'low'
  }

  // Infer parameters from context
  const inferred: ClassifiedIntent['inferred'] = {}
  if (uiContext.activeModelId) inferred.modelId = uiContext.activeModelId
  if (uiContext.activeLocale) inferred.locale = uiContext.activeLocale
  if (uiContext.activeEntryId) inferred.entryId = uiContext.activeEntryId

  return { category, confidence, inferred }
}

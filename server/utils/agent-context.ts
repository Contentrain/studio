import type { ChatUIContext, ClassifiedIntent, IntentCategory, ProjectPhase } from './agent-types'

/**
 * Intent classification — narrows agent scope based on message + UI context.
 *
 * Context section building is now in agent-system-prompt.ts (buildContextSection)
 * to keep all prompt logic in one file.
 */

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
    { category: 'model_operation', keywords: ['model oluştur', 'create model', 'add model', 'new model', 'field ekle', 'add field', 'alan ekle', 'model tanımla', 'yeni model', 'schema'] },
    { category: 'content_operation', keywords: ['ekle', 'add', 'create', 'oluştur', 'edit', 'update', 'düzenle', 'güncelle', 'delete', 'sil', 'remove', 'kaldır', 'translate', 'çevir', 'entry', 'içerik', 'yaz', 'değiştir', 'kaydet'] },
    { category: 'query', keywords: ['list', 'show', 'göster', 'what', 'how', 'ne', 'nasıl', 'kaç', 'how many', 'get', 'al', 'listele', 'neler var'] },
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

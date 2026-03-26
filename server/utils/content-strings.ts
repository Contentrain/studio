/**
 * Server-side content string reader.
 *
 * Reads dictionary models (agent-prompts, agent-messages, error-messages)
 * from .contentrain/content/system/ for use in server routes and system prompts.
 *
 * Caches JSON in memory after first read — invalidated when brain cache invalidates.
 * Zero runtime cost after first read (no Git API, no SDK overhead).
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

type StringDictionary = Record<string, string>

const cache = new Map<string, StringDictionary>()

function loadDictionary(model: string, locale: string = 'en'): StringDictionary {
  const cacheKey = `${model}:${locale}`
  const cached = cache.get(cacheKey)
  if (cached) return cached

  try {
    const filePath = resolve(process.cwd(), `.contentrain/content/system/${model}/${locale}.json`)
    const raw = readFileSync(filePath, 'utf-8')
    const data = JSON.parse(raw) as StringDictionary
    cache.set(cacheKey, data)
    return data
  }
  catch {
    // File not found or parse error — return empty dict
    return {}
  }
}

/**
 * Get a string from agent-prompts dictionary.
 * Used in buildSystemPrompt() for plan descriptions, feature guides, etc.
 */
export function agentPrompt(key: string, locale: string = 'en'): string {
  const dict = loadDictionary('agent-prompts', locale)
  return dict[key] ?? key
}

/**
 * Get a string from agent-messages dictionary.
 * Used in agent tool results for user-facing response messages.
 */
export function agentMessage(key: string, locale: string = 'en'): string {
  const dict = loadDictionary('agent-messages', locale)
  return dict[key] ?? key
}

/**
 * Get a string from error-messages dictionary.
 * Used in createError() responses across all server routes.
 */
export function errorMessage(key: string, locale: string = 'en'): string {
  const dict = loadDictionary('error-messages', locale)
  return dict[key] ?? key
}

/**
 * Clear cached dictionaries. Call when content changes
 * (e.g., after brain cache invalidation or webhook).
 */
export function clearStringCache(): void {
  cache.clear()
}

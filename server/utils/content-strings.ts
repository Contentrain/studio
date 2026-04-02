/**
 * Server-side content string reader.
 *
 * Uses @contentrain/query SDK to read dictionary models
 * (agent-prompts, agent-messages, error-messages) for server routes and system prompts.
 *
 * SDK reads from pre-generated .contentrain/client/ — synchronous, zero I/O.
 */

import { dictionary, query } from '#contentrain'

type Params = Record<string, string | number>

function interpolate(template: string, params?: Params): string {
  if (!params) return template
  let result = template
  for (const [k, v] of Object.entries(params)) {
    result = result.replaceAll(`{${k}}`, String(v))
  }
  return result
}

/**
 * Get a string from agent-prompts dictionary.
 * Used in buildSystemPrompt() for plan descriptions, feature guides, etc.
 */
export function agentPrompt(key: string, params?: Params, locale: string = 'en'): string {
  try {
    const value = dictionary('agent-prompts').locale(locale).get(key) ?? key
    return interpolate(value, params)
  }
  catch {
    return key
  }
}

/**
 * Get a string from agent-messages dictionary.
 * Used in agent tool results for user-facing response messages.
 */
export function agentMessage(key: string, params?: Params, locale: string = 'en'): string {
  try {
    const value = dictionary('agent-messages').locale(locale).get(key) ?? key
    return interpolate(value, params)
  }
  catch {
    return key
  }
}

/**
 * Get a string from error-messages dictionary.
 * Used in createError() responses across all server routes.
 */
export function errorMessage(key: string, params?: Params, locale: string = 'en'): string {
  try {
    const value = dictionary('error-messages').locale(locale).get(key) ?? key
    return interpolate(value, params)
  }
  catch {
    return key
  }
}

/**
 * Get subject + body from email-templates collection.
 * Looks up by slug, returns interpolated subject and body.
 */
export function emailTemplate(
  slug: string,
  params?: Params,
  locale: string = 'en',
): { subject: string, body: string } {
  try {
    const entries = query('email-templates').locale(locale).where('slug', slug).all()
    const entry = entries[0] as { subject?: string, body?: string } | undefined
    if (!entry) return { subject: slug, body: '' }
    return {
      subject: interpolate(entry.subject ?? slug, params),
      body: interpolate(entry.body ?? '', params),
    }
  }
  catch {
    return { subject: slug, body: '' }
  }
}

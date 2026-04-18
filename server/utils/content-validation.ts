/**
 * Studio content validation — delegates to `@contentrain/mcp/core/validator`.
 *
 * Prior to Faz S3, Studio owned a parallel validator (~285 loc) that
 * duplicated rules already present in MCP. Phase 10's validator-unify
 * in `@contentrain/mcp` merged both rule sets (Studio's email / URL
 * heuristics + polymorphic relation handling + nested recursion, plus
 * MCP's secret detection + unique constraints + field schema checks),
 * and explicitly shape-aligned `ValidationContext` so the swap is a
 * drop-in.
 *
 * Studio keeps only:
 * - The `ValidationContext` re-export for back-compat typing.
 * - `validateEntryId` boolean wrapper over types' nullable-string API.
 */

import {
  checkRelationIntegrity as mcpCheckRelationIntegrity,
  validateContent as mcpValidateContent,
} from '@contentrain/mcp/core/validator'
import { validateEntryId as _validateEntryId } from '@contentrain/types'
import type { FieldDef, ModelDefinition, ValidationError, ValidationResult } from '@contentrain/types'

/** Context for cross-entry validation (unique, relations) — kept for Studio callsite typing. */
export interface ValidationContext {
  allEntries?: Record<string, Record<string, unknown>>
  currentEntryId?: string
  models?: ModelDefinition[]
  /** Reserved for Studio flows that still pass a content loader through ctx. */
  loadContent?: (modelId: string, locale: string) => Promise<Record<string, unknown> | null>
}

export function validateContent(
  data: Record<string, unknown>,
  fields: Record<string, FieldDef>,
  modelId: string,
  locale: string,
  entryId?: string,
  ctx?: ValidationContext,
): ValidationResult {
  return mcpValidateContent(data, fields, modelId, locale, entryId, ctx)
}

export async function checkRelationIntegrity(
  data: Record<string, unknown>,
  fields: Record<string, FieldDef>,
  modelId: string,
  locale: string,
  entryId: string | undefined,
  loadContent: (targetModelId: string, locale: string) => Promise<Record<string, unknown> | null>,
): Promise<ValidationError[]> {
  return mcpCheckRelationIntegrity(data, fields, modelId, locale, entryId, loadContent)
}

/**
 * Validate an entry ID format. Returns `true` when the ID is valid;
 * `false` otherwise. Thin boolean wrapper over
 * `@contentrain/types:validateEntryId` (which returns an error message
 * or `null`) for backward compatibility with existing Studio call sites.
 */
export function validateEntryId(id: string): boolean {
  return _validateEntryId(id) === null
}

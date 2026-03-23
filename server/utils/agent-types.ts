import type { AITool } from '../providers/ai'

/**
 * Chat engine types — Bounded Task Executor architecture.
 *
 * These types enforce architectural constraints:
 * - UI context travels with every message (agent knows what user sees)
 * - State machine prevents invalid operations
 * - Intent classification narrows agent scope
 * - Affected resources drive targeted cache invalidation
 * - Workflow-aware merge rules respect review/auto-merge config
 */

// ─── UI Context (client → server) ───

/** Explicitly pinned context item from the content panel */
export interface ContextItem {
  type: 'model' | 'entry' | 'field'
  modelId: string
  modelName?: string
  entryId?: string
  fieldId?: string
  data?: unknown
}

/** What the user is currently looking at in the three-panel UI */
export interface ChatUIContext {
  /** Selected model in context panel (null = overview) */
  activeModelId: string | null
  /** Selected locale in context panel */
  activeLocale: string
  /** Expanded entry ID in context panel (null = no entry focused) */
  activeEntryId: string | null
  /** What the context panel is showing */
  panelState: 'overview' | 'model' | 'branch' | 'vocabulary'
  /** If viewing a branch, which one */
  activeBranch: string | null
  /** Explicitly pinned context items from the content panel */
  contextItems?: ContextItem[]
}

/** Full chat request body */
export interface ChatRequest {
  message: string
  conversationId?: string
  model?: string
  context: ChatUIContext
}

// ─── Intent Classification ───

export type IntentCategory
  = 'content_operation'
    | 'model_operation'
    | 'branch_operation'
    | 'project_operation'
    | 'query'
    | 'out_of_scope'

export interface ClassifiedIntent {
  category: IntentCategory
  confidence: 'high' | 'medium' | 'low'
  /** Inferred parameters from UI context + message keywords */
  inferred: {
    modelId?: string
    locale?: string
    entryId?: string
  }
}

// ─── Project Phase (State Machine) ───

export type ProjectPhase
  = 'uninitialized'
    | 'init_pending'
    | 'active'
    | 'error'

export interface StateCheck {
  allowed: boolean
  reason?: string
  suggestion?: string
}

// ─── Tool Execution Results ───

/** What resources a tool execution affected — drives cache invalidation */
export interface AffectedResources {
  /** Model IDs that had content changes */
  models: string[]
  /** Locales that were affected */
  locales: string[]
  /** Whether snapshot needs refresh (model definitions changed, init, etc.) */
  snapshotChanged: boolean
  /** Whether branch list changed */
  branchesChanged: boolean
  /** Specific branch created/merged/deleted */
  branch?: string
}

/** Tool result with metadata for orchestration */
export interface ToolResultWithMeta {
  result: unknown
  affected: AffectedResources
}

/** Empty affected resources (no changes) */
export function emptyAffected(): AffectedResources {
  return { models: [], locales: [], snapshotChanged: false, branchesChanged: false }
}

/** Merge two AffectedResources (accumulate across tool calls) */
export function mergeAffected(a: AffectedResources, b: AffectedResources): AffectedResources {
  return {
    models: [...new Set([...a.models, ...b.models])],
    locales: [...new Set([...a.locales, ...b.locales])],
    snapshotChanged: a.snapshotChanged || b.snapshotChanged,
    branchesChanged: a.branchesChanged || b.branchesChanged,
    branch: b.branch ?? a.branch,
  }
}

// ─── Extended Tool Definition ───

/** Studio tool with orchestration metadata (extends AITool) */
export interface StudioTool extends AITool {
  /** Which project phases allow this tool */
  requiredPhase: ProjectPhase[]
  /** What resources this tool typically affects */
  defaultAffects: Partial<AffectedResources>
  /** Workflow-specific merge behavior */
  workflowBehavior: 'auto-merge' | 'workflow-dependent' | 'manual' | 'none'
}

/** Strip orchestration metadata — only send name/description/inputSchema to LLM */
export function toAITools(tools: StudioTool[]): AITool[] {
  return tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }))
}

import type { DeepReadonly } from 'vue'

/**
 * What the caller may write in a project, as the brain sync hands it to the
 * client. Same source as the save routes' own check (`resolveAgentPermissions`),
 * so the UI hides exactly what the server would refuse with a 403.
 */
export interface BrainSyncAccess {
  availableTools: string[]
  /** The member is limited to `allowedModels`. */
  specificModels: boolean
  allowedModels: string[]
}

/**
 * Whether the caller may save content — the gate `content/[modelId].post.ts`
 * applies: `save_content`, then, for a model, the model list when the member is
 * limited to specific models. Without a model it is the project-wide check
 * `vocabulary.patch.ts` makes. No access known yet → no.
 */
export function canSaveContent(access: DeepReadonly<BrainSyncAccess> | null | undefined, modelId?: string | null): boolean {
  if (!access?.availableTools.includes('save_content')) return false
  if (!modelId || !access.specificModels) return true
  return access.allowedModels.includes(modelId)
}

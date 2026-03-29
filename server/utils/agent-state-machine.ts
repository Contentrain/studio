import type { ContentrainConfig } from '@contentrain/types'
import type { Branch } from '../providers/git'
import type { ProjectPhase, StateCheck, StudioTool } from './agent-types'

/**
 * Project state machine — enforces valid operation sequences.
 *
 * This is an ARCHITECTURAL constraint, not a prompt instruction.
 * The LLM can TRY to call any tool, but the state machine will
 * reject invalid operations and return a clear reason + suggestion.
 */

/** Derive the current project phase from available data */
export function deriveProjectPhase(
  config: ContentrainConfig | null,
  pendingBranches: Branch[],
  projectStatus: string,
): ProjectPhase {
  if (projectStatus === 'error') return 'error'

  if (!config) {
    const hasInitBranch = pendingBranches.some(b => b.name.startsWith('cr/new/init/'))
    return hasInitBranch ? 'init_pending' : 'uninitialized'
  }

  return 'active'
}

/** Check if a tool can be executed in the current phase */
export function checkStateTransition(
  phase: ProjectPhase,
  toolName: string,
): StateCheck {
  // Tools that are always allowed (read-only or diagnostic)
  const alwaysAllowed = ['list_models', 'list_branches', 'validate', 'validate_schema', 'list_submissions']
  if (alwaysAllowed.includes(toolName)) {
    return { allowed: true }
  }

  switch (phase) {
    case 'uninitialized':
      if (toolName === 'init_project') return { allowed: true }
      return {
        allowed: false,
        reason: 'Project is not initialized. No .contentrain/ directory exists.',
        suggestion: 'Call init_project first to set up the content structure.',
      }

    case 'init_pending':
      if (toolName === 'merge_branch' || toolName === 'reject_branch') return { allowed: true }
      if (toolName === 'init_project') {
        return {
          allowed: false,
          reason: 'An init branch already exists and is pending merge.',
          suggestion: 'Merge the pending init branch first, or reject it to start over.',
        }
      }
      return {
        allowed: false,
        reason: 'Project initialization is pending. A cr/new/init/* branch needs to be merged first.',
        suggestion: 'Merge the pending init branch before performing content operations.',
      }

    case 'active':
      if (toolName === 'init_project') {
        return {
          allowed: false,
          reason: 'Project is already initialized.',
          suggestion: 'The project has a .contentrain/ directory. Use save_content or save_model instead.',
        }
      }
      return { allowed: true }

    case 'error':
      if (toolName === 'merge_branch' || toolName === 'reject_branch') return { allowed: true }
      return {
        allowed: false,
        reason: 'Project is in error state.',
        suggestion: 'Check the project status in settings.',
      }

    default:
      return { allowed: true }
  }
}

/** Filter tools list by project phase — remove tools that can't run */
export function filterToolsByPhase(tools: StudioTool[], phase: ProjectPhase): StudioTool[] {
  return tools.filter(tool => tool.requiredPhase.includes(phase))
}

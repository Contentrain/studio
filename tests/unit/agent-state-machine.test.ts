import { describe, expect, it } from 'vitest'
import { checkStateTransition, deriveProjectPhase, filterToolsByPhase } from '../../server/utils/agent-state-machine'

describe('agent state machine', () => {
  it('derives the correct project phase from config, status, and init branches', () => {
    expect(deriveProjectPhase(null, [], 'active')).toBe('uninitialized')
    expect(deriveProjectPhase(null, [{ name: 'cr/new/init/1234567890-abcd', sha: 'sha-1', protected: false }], 'active')).toBe('init_pending')
    expect(deriveProjectPhase({} as never, [], 'active')).toBe('active')
    expect(deriveProjectPhase({} as never, [], 'error')).toBe('error')
  })

  it('blocks invalid tool transitions with actionable suggestions', () => {
    expect(checkStateTransition('uninitialized', 'save_content')).toEqual({
      allowed: false,
      reason: 'Project is not initialized. No .contentrain/ directory exists.',
      suggestion: 'Call init_project first to set up the content structure.',
    })

    expect(checkStateTransition('init_pending', 'init_project')).toEqual({
      allowed: false,
      reason: 'An init branch already exists and is pending merge.',
      suggestion: 'Merge the pending init branch first, or reject it to start over.',
    })

    expect(checkStateTransition('active', 'init_project')).toEqual({
      allowed: false,
      reason: 'Project is already initialized.',
      suggestion: 'The project has a .contentrain/ directory. Use save_content or save_model instead.',
    })
  })

  it('keeps read-only tools available and filters tools by phase', () => {
    expect(checkStateTransition('error', 'list_models')).toEqual({ allowed: true })

    const tools = [
      { name: 'init_project', requiredPhase: ['uninitialized'] },
      { name: 'save_content', requiredPhase: ['active'] },
      { name: 'merge_branch', requiredPhase: ['init_pending', 'active', 'error'] },
    ] as never

    expect(filterToolsByPhase(tools, 'active').map(tool => tool.name)).toEqual([
      'save_content',
      'merge_branch',
    ])
  })
})

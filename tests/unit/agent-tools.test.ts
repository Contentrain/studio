import { describe, expect, it } from 'vitest'
import { STUDIO_TOOLS } from '../../server/utils/agent-tools'

describe('STUDIO_TOOLS', () => {
  it('defines unique tool names with required orchestration metadata', () => {
    const names = STUDIO_TOOLS.map(tool => tool.name)

    expect(new Set(names).size).toBe(names.length)

    for (const tool of STUDIO_TOOLS) {
      expect(tool.description.length).toBeGreaterThan(10)
      expect(tool.requiredPhase.length).toBeGreaterThan(0)
      expect(tool.defaultAffects).toBeTruthy()
      expect(['none', 'auto-merge', 'manual', 'workflow-dependent']).toContain(tool.workflowBehavior)
    }
  })

  it('includes core content, branch, brain, and media tools', () => {
    const names = STUDIO_TOOLS.map(tool => tool.name)

    expect(names).toEqual(expect.arrayContaining([
      'list_models',
      'get_content',
      'save_content',
      'save_model',
      'list_branches',
      'merge_branch',
      'brain_query',
      'brain_search',
      'search_media',
      'upload_media',
    ]))
  })
})

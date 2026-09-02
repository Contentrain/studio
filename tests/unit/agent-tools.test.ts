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

  it('lets save_content schedule beside data, and says it is not a publish', () => {
    const saveContent = STUDIO_TOOLS.find(tool => tool.name === 'save_content')!
    const properties = saveContent.inputSchema.properties as Record<string, unknown>

    expect(Object.keys(properties)).toEqual(expect.arrayContaining(['publish_at', 'expire_at']))
    expect(saveContent.description).toContain('NEVER change status')
    expect(saveContent.description).toContain('never inside it')
  })

  it('tells the agent that save_model merges, and gives it the removal and title-field handles', () => {
    // A one-field payload once replaced a 39-field model; the schema now
    // carries the contract the engine enforces.
    const saveModel = STUDIO_TOOLS.find(tool => tool.name === 'save_model')!
    const properties = saveModel.inputSchema.properties as Record<string, unknown>

    expect(saveModel.description).toContain('UPDATES MERGE')
    expect(saveModel.description).toContain('remove_fields')
    expect(Object.keys(properties)).toEqual(expect.arrayContaining(['title_field', 'remove_fields', 'allow_breaking']))
    expect(saveModel.description).toContain('label')
    expect(saveModel.description).toContain('order')
  })
})

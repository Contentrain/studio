import { describe, expect, it } from 'vitest'
import { emptyAffected, mergeAffected, toAITools } from '../../server/utils/agent-types'

describe('agent types helpers', () => {
  it('creates an empty affected resources object', () => {
    expect(emptyAffected()).toEqual({
      models: [],
      locales: [],
      snapshotChanged: false,
      branchesChanged: false,
    })
  })

  it('merges affected resource state across tool executions', () => {
    expect(mergeAffected(
      {
        models: ['faq'],
        locales: ['en'],
        snapshotChanged: false,
        branchesChanged: true,
        branch: 'cr/content/faq/en/1234567890-abcd',
      },
      {
        models: ['docs', 'faq'],
        locales: ['tr'],
        snapshotChanged: true,
        branchesChanged: false,
      },
    )).toEqual({
      models: ['faq', 'docs'],
      locales: ['en', 'tr'],
      snapshotChanged: true,
      branchesChanged: true,
      branch: 'cr/content/faq/en/1234567890-abcd',
    })
  })

  it('strips orchestration metadata before exposing tools to the ai provider', () => {
    expect(toAITools([
      {
        name: 'save_content',
        description: 'Save content',
        inputSchema: { type: 'object' },
        requiredPhase: ['active'],
        defaultAffects: { models: ['faq'] },
        workflowBehavior: 'workflow-dependent',
      },
    ] as never)).toEqual([
      {
        name: 'save_content',
        description: 'Save content',
        inputSchema: { type: 'object' },
      },
    ])
  })
})

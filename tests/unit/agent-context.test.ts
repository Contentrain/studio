import { describe, expect, it } from 'vitest'
import { classifyIntent } from '../../server/utils/agent-context'

describe('agent context classification', () => {
  const uiContext = {
    activeModelId: 'faq',
    activeLocale: 'tr',
    activeEntryId: 'entry-1',
    panelState: 'content',
    activeBranch: null,
  } as const

  it('classifies explicit project and branch operations with high confidence', () => {
    expect(classifyIntent('Projeyi initialize et', uiContext, 'uninitialized')).toMatchObject({
      category: 'project_operation',
      confidence: 'high',
    })

    expect(classifyIntent('Bu branchi merge et', uiContext, 'active')).toMatchObject({
      category: 'branch_operation',
      confidence: 'high',
    })
  })

  it('falls back to contextual content operations when a model is active', () => {
    expect(classifyIntent('metni sadeleştir', uiContext, 'active')).toEqual({
      category: 'content_operation',
      confidence: 'medium',
      inferred: {
        modelId: 'faq',
        locale: 'tr',
        entryId: 'entry-1',
      },
    })
  })

  it('treats short unmatched messages as low confidence queries', () => {
    expect(classifyIntent('selam', {
      activeModelId: null,
      activeLocale: 'en',
      activeEntryId: null,
      panelState: 'overview',
      activeBranch: null,
    }, 'active')).toEqual({
      category: 'query',
      confidence: 'low',
      inferred: {
        locale: 'en',
      },
    })
  })
})

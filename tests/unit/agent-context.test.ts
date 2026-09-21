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

  it('classifies Turkish status/publish verbs as content operations, not queries (regression for #291)', () => {
    const cases = ['yayınla', 'yayından kaldır', 'taslağa al', 'draft hale getir', 'arşivle']
    for (const message of cases) {
      expect(classifyIntent(message, uiContext, 'active')).toMatchObject({
        category: 'content_operation',
        confidence: 'high',
      })
    }
  })

  it('does not match a short keyword embedded inside an unrelated Turkish word (regression for #291)', () => {
    // "hale" contains the substring "al" — a `query` keyword — but is not
    // the word "al". Before the word-boundary fix, `lower.includes('al')`
    // matched here and misclassified "draft hale getir" as a read.
    const noModelContext = { ...uiContext, activeModelId: null }
    const result = classifyIntent('Böyle bir hale geldi işte açıklayayım sana', noModelContext, 'active')
    expect(result.category).not.toBe('query')
  })
})

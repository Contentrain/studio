import type { ApprovalPolicyFile } from '@contentrain/types'
import { describe, expect, it } from 'vitest'
import labelled from '../fixtures/approval-gate/labelled-writes.json'
import { decideMerge, LARGE_TEXT_CHANGE_CHARS, toolRisk, writeSignals } from '../../server/utils/approval-gate'

/** A project that trusts content edits and nothing else — the policy the signals matter for. */
const autoContent: ApprovalPolicyFile = {
  version: 1,
  rules: [
    { risk: 'low_risk_content', gate: 'change', mode: 'auto' },
    { risk: 'bulk_content', gate: 'change', mode: 'single' },
  ],
}

describe('write signals', () => {
  it('reads the target status of a status change', () => {
    expect(writeSignals('update_status', { status: 'published', entryIds: ['a'] })).toEqual({ targetStatus: 'published' })
  })

  it('counts emptied fields and text across an entry map, a document and a singleton', () => {
    expect(writeSignals('save_content', { data: { a: { title: '', tags: [], body: 'hello' } } }))
      .toEqual({ emptiedFields: 2, textChars: 5 })
    expect(writeSignals('save_content', { slug: 'post', data: { body: 'x'.repeat(10), cover: null } }))
      .toEqual({ emptiedFields: 1, textChars: 10 })
    expect(writeSignals('save_content', { data: { site_name: 'Acme', count: 3 } }))
      .toEqual({ emptiedFields: 0, textChars: 4 })
  })

  it('reads nothing from other tools', () => {
    expect(writeSignals('delete_content', { entryIds: ['a'] })).toEqual({})
  })
})

describe('signal lift', () => {
  it('lifts a one-entry edit that changes visibility, empties a field or rewrites a large text', () => {
    const one = { entries: ['a'] }
    expect(toolRisk('update_status', one, { targetStatus: 'published' })).toBe('bulk_content')
    expect(toolRisk('update_status', one, { targetStatus: 'archived' })).toBe('bulk_content')
    expect(toolRisk('update_status', one, { targetStatus: 'draft' })).toBe('low_risk_content')
    expect(toolRisk('save_content', one, { emptiedFields: 1 })).toBe('bulk_content')
    expect(toolRisk('save_content', one, { textChars: LARGE_TEXT_CHANGE_CHARS })).toBe('bulk_content')
    expect(toolRisk('save_content', one, { textChars: LARGE_TEXT_CHANGE_CHARS - 1 })).toBe('low_risk_content')
  })

  it('never lowers a class', () => {
    expect(toolRisk('delete_content', { entries: ['a'] }, {})).toBe('bulk_content')
    expect(toolRisk('save_model', {}, { textChars: 0 })).toBe('destructive_schema')
  })

  it('holds a lifted write under a policy that trusts content edits, and says why', async () => {
    const small = await decideMerge({ workflow: 'review', tool: 'save_content', scope: { entries: ['a'] }, signals: { textChars: 40 }, policy: autoContent })
    expect(small.allowed).toBe(true)

    const publish = await decideMerge({ workflow: 'review', tool: 'update_status', scope: { entries: ['a'] }, signals: { targetStatus: 'published' }, policy: autoContent })
    expect(publish.allowed).toBe(false)
    expect(publish.review.approval?.risk).toBe('bulk_content')
    expect(publish.review.approval?.reasons[0]).toContain('moves content to `published`')
  })
})

/**
 * The labelled set the thresholds were chosen against. It pins two things:
 * every write both labellers held that the tool alone called low risk is
 * lifted, and nothing either labeller let through is lifted.
 */
describe('labelled writes', () => {
  interface Item {
    id: string
    source: 'real' | 'synthetic'
    tool: string
    entryCount: number | null
    targetStatus: string | null
    emptiedFields: number
    textChars: number
    labels: { a: 'review' | 'no_review', b: 'review' | 'no_review' }
  }
  const items = labelled.items as Item[]
  const rung = (x: Item) => toolRisk(
    x.tool,
    { entries: Array.from({ length: x.entryCount ?? 0 }, (_, i) => `e${i}`) },
    { targetStatus: x.targetStatus ?? undefined, emptiedFields: x.emptiedFields, textChars: x.textChars },
  )
  const toolOnly = (x: Item) => toolRisk(x.tool, { entries: Array.from({ length: x.entryCount ?? 0 }, (_, i) => `e${i}`) })
  const lowByTool = items.filter(x => toolOnly(x) === 'low_risk_content')

  it('has the set it was built from', () => {
    expect(items).toHaveLength(90)
    expect(lowByTool).toHaveLength(75)
  })

  it('lifts every write both labellers would hold', () => {
    const bothReview = lowByTool.filter(x => x.labels.a === 'review' && x.labels.b === 'review')
    expect(bothReview).toHaveLength(27)
    expect(bothReview.filter(x => rung(x) === 'low_risk_content').map(x => x.id)).toEqual([])
  })

  it('lifts nothing either labeller would let through', () => {
    const letThrough = lowByTool.filter(x => x.labels.a === 'no_review' || x.labels.b === 'no_review')
    expect(letThrough.filter(x => rung(x) !== 'low_risk_content').map(x => x.id)).toEqual([])
  })
})

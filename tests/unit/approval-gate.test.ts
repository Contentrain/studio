import type { ApprovalPolicyFile } from '@contentrain/types'
import { describe, expect, it } from 'vitest'
import { CLASSIFIED_WRITE_TOOLS, decideMerge, parseApprovalPolicy, savedEntryIds, toolRisk } from '../../server/utils/approval-gate'

/** Auto-approve content edits, nothing else. The shape a project writes to keep the old behaviour. */
const autoContent: ApprovalPolicyFile = {
  version: 1,
  rules: [{ risk: 'low_risk_content', gate: 'change', mode: 'auto' }],
}

describe('tool risk', () => {
  it('puts a delete and a schema change above a content edit', () => {
    expect(toolRisk('save_content')).toBe('low_risk_content')
    expect(toolRisk('delete_content')).toBe('bulk_content')
    expect(toolRisk('save_model')).toBe('destructive_schema')
    expect(toolRisk('delete_model')).toBe('destructive_schema')
  })

  it('lifts a content write to bulk once it touches more than one entry', () => {
    expect(toolRisk('save_content', { entries: ['a'] })).toBe('low_risk_content')
    expect(toolRisk('save_content', { entries: ['a', 'b'] })).toBe('bulk_content')
    // A tool already above the content rung is not lowered by touching one entry.
    expect(toolRisk('delete_content', { entries: ['a'] })).toBe('bulk_content')
  })

  it('treats an unclassified tool as a read', () => {
    // Reads never reach the gate; the map is the allowlist, so an unknown name
    // lands on `read_only` rather than inheriting a write's rung.
    expect(toolRisk('list_models')).toBe('read_only')
  })

  it('reads the entries of a save from its payload', () => {
    expect(savedEntryIds({ slug: 'field-notes' })).toEqual(['field-notes'])
    expect(savedEntryIds({ data: { a: {}, b: {} } })).toEqual(['a', 'b'])
    expect(savedEntryIds({})).toEqual([])
  })
})

describe('policy parsing', () => {
  it('accepts a well-formed policy', () => {
    const { policy, error } = parseApprovalPolicy(JSON.stringify(autoContent))
    expect(error).toBeNull()
    expect(policy?.rules).toHaveLength(1)
  })

  it('refuses a policy it would misread, and says what is wrong', () => {
    expect(parseApprovalPolicy('{').error).toBe('not valid JSON')
    expect(parseApprovalPolicy('[]').error).toBe('not an object')
    expect(parseApprovalPolicy('{"rules":[]}').error).toContain('`version`')
    expect(parseApprovalPolicy('{"version":1}').error).toContain('`rules`')
    expect(parseApprovalPolicy('{"version":1,"rules":[{"risk":"whenever","gate":"change","mode":"single"}]}').error)
      .toContain('unknown `risk`')
    expect(parseApprovalPolicy('{"version":1,"rules":[{"risk":"low_risk_content","gate":"change","mode":"vibes"}]}').error)
      .toContain('unknown `mode`')
  })
})

describe('merge decision', () => {
  it('never consults the policy on an auto-merge project', async () => {
    // Strictest possible policy; the workflow setting still decides whether the
    // evaluator is asked at all.
    const strict: ApprovalPolicyFile = { version: 1, rules: [{ risk: 'read_only', gate: 'change', mode: 'quorum', min_approvals: 3 }] }
    const decision = await decideMerge({ workflow: 'auto-merge', tool: 'delete_model', policy: strict })
    expect(decision.allowed).toBe(true)
    expect(decision.review).toEqual({})
  })

  it('holds an ordinary content write under review with no policy of its own', async () => {
    // The default policy asks for one review on anything above `read_only`, and
    // this is the behaviour change: the old rule let an owner merge here.
    const decision = await decideMerge({ workflow: 'review', tool: 'save_content', scope: { models: ['posts'], entries: ['a'] } })
    expect(decision.allowed).toBe(false)
    expect(decision.review.approval?.risk).toBe('low_risk_content')
    expect(decision.review.approval?.reasons.length).toBeGreaterThan(0)
    expect(decision.review.approval?.outstanding[0]).toMatchObject({ gate: 'change', remaining: 1 })
  })

  it('lets a project opt back into auto-merge for the class it trusts', async () => {
    const decision = await decideMerge({ workflow: 'review', tool: 'save_content', scope: { entries: ['a'] }, policy: autoContent })
    expect(decision.allowed).toBe(true)
  })

  it('does not carry that trust up the ladder', async () => {
    // `auto` is the one mode that does not climb. Every other mode written at a
    // rung also covers the rungs above it; if `auto` did, one trusted rule at
    // the bottom would exempt every heavy operation above it.
    const withDefault: ApprovalPolicyFile = { ...autoContent, default_mode: 'single' }

    const bulk = await decideMerge({ workflow: 'review', tool: 'save_content', scope: { entries: ['a', 'b'] }, policy: withDefault })
    expect(bulk.allowed).toBe(false)
    expect(bulk.review.approval?.risk).toBe('bulk_content')

    const schema = await decideMerge({ workflow: 'review', tool: 'save_model', policy: withDefault })
    expect(schema.allowed).toBe(false)
    expect(schema.review.approval?.risk).toBe('destructive_schema')
  })

  it('lets a policy that names no rule for a class say nothing about it', async () => {
    // The trap worth knowing before writing a policy file: a rule set whose
    // only entry is `auto` at the bottom rung, with no `default_mode`, leaves
    // everything above it matched by nothing — and the evaluator takes a
    // policy's silence literally rather than inventing a requirement. This is
    // why `docs/REVIEW_WORKFLOW.md` tells an author to write `default_mode`.
    const schema = await decideMerge({ workflow: 'review', tool: 'save_model', policy: autoContent })
    expect(schema.allowed).toBe(true)
  })
})

describe('classification coverage', () => {
  it('classifies every write tool the conversation engine gates', async () => {
    // The engine calls the gate at exactly these tools. A new one added there
    // without a risk class would evaluate as `read_only` and merge itself.
    const source = await import('node:fs').then(fs => fs.readFileSync('server/utils/conversation-engine.ts', 'utf8'))
    const gated = new Set<string>()
    for (const match of source.matchAll(/case '([a-z_]+)': \{/g)) {
      const name = match[1]!
      const block = source.slice(match.index, source.indexOf('      case \'', match.index + 10))
      if (block.includes('gateMerge(')) gated.add(name)
    }
    expect(gated.size).toBeGreaterThan(0)
    expect([...gated].sort()).toEqual([...CLASSIFIED_WRITE_TOOLS].sort())
  })
})

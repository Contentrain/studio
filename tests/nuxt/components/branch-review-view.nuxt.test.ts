import type { BranchReview } from '../../../shared/utils/branch-review'
import { describe, expect, it } from 'vitest'
import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import BranchReviewView from '../../../app/components/organisms/BranchReviewView.vue'

mockNuxtImport('useRoute', () => () => ({ query: {}, params: {} }))
mockNuxtImport('useSanitize', () => () => ({ sanitize: (html: string) => html }))

function makeReview(overrides: Partial<BranchReview> = {}): BranchReview {
  return {
    branch: 'cr/content/plans/en/1755612345-a3f2',
    info: {
      scope: 'content',
      modelId: 'plans',
      modelName: 'Plans',
      locale: 'en',
      timestamp: 1755612345,
      updatedBy: 'editor@contentrain.io',
      updatedAt: new Date().toISOString(),
    },
    groups: [{
      modelId: 'plans',
      modelName: 'Plans',
      kind: 'collection',
      locale: 'en',
      entries: [{
        kind: 'updated',
        entryId: 'free',
        title: 'Free',
        fields: [{ fieldId: 'price_monthly', label: 'Monthly price', type: 'number', before: 0, after: 9 }],
        statusBefore: null,
        statusAfter: null,
        updatedBy: 'editor@contentrain.io',
        updatedAt: new Date().toISOString(),
      }],
      omittedEntries: 0,
    }],
    schema: [],
    settings: [],
    unclassified: [],
    summary: { added: 0, updated: 1, removed: 0 },
    canMerge: true,
    canReject: true,
    ...overrides,
  }
}

describe('BranchReviewView', () => {
  it('names the entry and its changed field, not the file it lives in', async () => {
    const wrapper = await mountSuspended(BranchReviewView, { props: { review: makeReview() } })
    const text = wrapper.text()

    expect(text).toContain('Plans')
    expect(text).toContain('Free')
    expect(text).toContain('Monthly price')
    // The old panel printed the path and the whole entry object; neither is here.
    expect(text).not.toContain('.contentrain/content')
    expect(text).not.toContain('price_monthly')
  })

  it('states what approving will do', async () => {
    const wrapper = await mountSuspended(BranchReviewView, { props: { review: makeReview() } })
    expect(wrapper.text()).toContain('Approve 1 change')
  })

  it('offers no action a viewer would get a 403 for', async () => {
    const wrapper = await mountSuspended(BranchReviewView, {
      props: { review: makeReview({ canMerge: false, canReject: false }) },
    })

    expect(wrapper.text()).not.toContain('Approve')
    expect(wrapper.text()).toContain('You do not have permission')
  })

  it('asks for the file-level diff only when the technical view is opened', async () => {
    const wrapper = await mountSuspended(BranchReviewView, { props: { review: makeReview() } })

    expect(wrapper.emitted('loadRaw')).toBeUndefined()

    await wrapper.findAll('button').find(b => b.text().includes('Technical view'))!.trigger('click')
    expect(wrapper.emitted('loadRaw')).toHaveLength(1)
  })

  it('shows a file it could not attribute rather than swallowing it', async () => {
    const wrapper = await mountSuspended(BranchReviewView, {
      props: {
        review: makeReview({
          unclassified: [{ path: 'src/content/mystery.json', status: 'added' }],
        }),
      },
    })

    expect(wrapper.text()).toContain('src/content/mystery.json')
  })

  it('warns before a structure change that content may not survive', async () => {
    const wrapper = await mountSuspended(BranchReviewView, {
      props: {
        review: makeReview({
          schema: [{
            kind: 'updated',
            modelId: 'plans',
            modelName: 'Plans',
            added: [],
            removed: [{ fieldId: 'badge_text', label: 'Badge text', type: 'string' }],
            retyped: [],
            titleFieldBefore: null,
            titleFieldAfter: null,
            destructive: true,
          }],
        }),
      },
    })

    expect(wrapper.text()).toContain('Badge text')
    expect(wrapper.text()).toContain('Existing content may not survive')
    expect(wrapper.text()).toContain('Read the structure section before approving')
  })

  it('says a publish once, as a transition, not three times', async () => {
    const review = makeReview()
    review.groups[0]!.entries[0] = {
      kind: 'updated',
      entryId: 'free',
      title: 'Free',
      fields: [],
      statusBefore: 'draft',
      statusAfter: 'published',
      updatedBy: 'editor@contentrain.io',
      updatedAt: new Date().toISOString(),
    }

    const wrapper = await mountSuspended(BranchReviewView, { props: { review } })
    expect(wrapper.text()).toContain('Draft → Published')
    // The kind badge said "updated" next to it, for an entry whose only change
    // was the status the badge beside it already named.
    expect(wrapper.text()).not.toContain('updated')
  })

  it('does not open a row onto nothing', async () => {
    // A publish that touched no field leaves an empty body: no fields, no
    // author line once it matches the header's, and no "nothing changed" note
    // because the badge already said what happened.
    const review = makeReview()
    review.groups[0]!.entries[0] = {
      kind: 'updated',
      entryId: 'free',
      title: 'Free',
      fields: [],
      statusBefore: 'draft',
      statusAfter: 'published',
      updatedBy: review.info.updatedBy,
      updatedAt: review.info.updatedAt,
    }

    const wrapper = await mountSuspended(BranchReviewView, { props: { review } })
    expect(wrapper.text()).toContain('Draft → Published')
    // No disclosure at all, rather than one that reveals empty space.
    expect(wrapper.findAll('details')).toHaveLength(0)
  })

  it('still shows a headless entry whose only change is its status', async () => {
    const review = makeReview()
    review.groups[0] = {
      modelId: 'site-settings',
      modelName: 'site-settings',
      kind: 'singleton',
      locale: 'en',
      entries: [{
        kind: 'updated',
        entryId: 'site-settings',
        title: 'site-settings',
        fields: [],
        statusBefore: 'draft',
        statusAfter: 'published',
        updatedBy: review.info.updatedBy,
        updatedAt: review.info.updatedAt,
      }],
      omittedEntries: 0,
    }

    const wrapper = await mountSuspended(BranchReviewView, { props: { review } })
    expect(wrapper.text()).toContain('Draft → Published')
  })

  it('does not mark every field of a new entry as set', async () => {
    const review = makeReview()
    review.groups[0]!.entries[0] = {
      kind: 'added',
      entryId: 'team',
      title: 'Team',
      fields: [
        { fieldId: 'name', label: 'Name', type: 'string', before: undefined, after: 'Team' },
        { fieldId: 'price_monthly', label: 'Monthly price', type: 'number', before: undefined, after: 99 },
      ],
      statusBefore: null,
      statusAfter: null,
      updatedBy: null,
      updatedAt: null,
    }

    const wrapper = await mountSuspended(BranchReviewView, { props: { review } })
    expect(wrapper.text()).toContain('added')
    expect(wrapper.text()).not.toContain('set')
  })

  it('does not name a singleton three times over', async () => {
    const review = makeReview()
    review.info.modelId = 'site-settings'
    review.info.modelName = 'site-settings'
    review.groups[0] = {
      modelId: 'site-settings',
      modelName: 'site-settings',
      kind: 'singleton',
      locale: 'en',
      entries: [{
        kind: 'updated',
        entryId: 'site-settings',
        title: 'site-settings',
        fields: [{ fieldId: 'site_name', label: 'Site name', type: 'string', before: 'Relay', after: 'Relay Control' }],
        statusBefore: null,
        statusAfter: null,
        updatedBy: 'editor@contentrain.io',
        updatedAt: review.info.updatedAt,
      }],
      omittedEntries: 0,
    }

    const wrapper = await mountSuspended(BranchReviewView, { props: { review } })
    // Once, in the panel header — not again as a group label and an entry row.
    expect(wrapper.text().match(/site-settings/g)).toHaveLength(1)
    expect(wrapper.text()).toContain('Site name')
  })

  it('says the author once when every entry shares the header one', async () => {
    const review = makeReview()
    const wrapper = await mountSuspended(BranchReviewView, { props: { review } })

    expect(wrapper.text().match(/editor@contentrain\.io/g)).toHaveLength(1)
  })

  it('marks which list items moved instead of printing two lists', async () => {
    const review = makeReview()
    review.groups[0]!.entries[0]!.fields = [{
      fieldId: 'features',
      label: 'Features',
      type: 'array',
      before: ['Structured UI dictionary', 'Basic approval workflow'],
      after: ['Structured UI dictionary', 'Priority support queue'],
    }]

    const wrapper = await mountSuspended(BranchReviewView, { props: { review } })
    // One list: the shared item once, the dropped one struck through, the new
    // one highlighted — rather than both lists whole, for the reader to compare.
    expect(wrapper.text().match(/Structured UI dictionary/g)).toHaveLength(1)
    expect(wrapper.find('.line-through').text()).toBe('Basic approval workflow')
  })

  it('reports a publish as a status change, with no field noise to read past', async () => {
    const review = makeReview()
    review.groups[0]!.entries[0] = {
      kind: 'updated',
      entryId: 'free',
      title: 'Free',
      fields: [],
      statusBefore: 'draft',
      statusAfter: 'published',
      updatedBy: 'editor@contentrain.io',
      updatedAt: new Date().toISOString(),
    }

    const wrapper = await mountSuspended(BranchReviewView, { props: { review } })
    expect(wrapper.text()).toContain('Published')
    expect(wrapper.text()).toContain('Draft')
  })

  it('shows a reviewer\'s change request and lets a reviewer send one back', async () => {
    const wrapper = await mountSuspended(BranchReviewView, {
      props: {
        review: makeReview({
          canRequestChanges: true,
          changesRequested: { comment: 'Please shorten the intro.', requestedBy: 'user-2', requestedAt: new Date().toISOString() },
        }),
      },
    })

    expect(wrapper.text()).toContain('Changes requested')
    expect(wrapper.text()).toContain('Please shorten the intro.')

    await wrapper.findAll('button').find(b => b.text().includes('Request changes'))!.trigger('click')
    const textarea = wrapper.find('textarea')
    expect(textarea.exists()).toBe(true)
    await textarea.setValue('Fix the date too')
    await wrapper.findAll('button').find(b => b.text().includes('Send back'))!.trigger('click')
    expect(wrapper.emitted('requestChanges')).toEqual([['Fix the date too']])

    await wrapper.findAll('button').find(b => b.text().includes('Mark addressed'))!.trigger('click')
    expect(wrapper.emitted('resolveRequest')).toHaveLength(1)
  })
})

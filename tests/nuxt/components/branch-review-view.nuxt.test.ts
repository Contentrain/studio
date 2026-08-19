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
})

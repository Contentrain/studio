import { describe, expect, it } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import ContentFieldDisplay from '../../../app/components/atoms/ContentFieldDisplay.vue'

const LONG_TOKEN = 'a'.repeat(200)

describe('ContentFieldDisplay overflow handling', () => {
  it('folds a nested object into a collapsible block instead of one long line', async () => {
    const wrapper = await mountSuspended(ContentFieldDisplay, {
      props: { fieldId: 'f1', type: 'object', value: { theme: { mode: 'dark', accent: 'blue', radius: 4 } } },
    })

    const details = wrapper.find('details')
    expect(details.exists()).toBe(true)
    expect(details.find('summary').text()).toContain('3 field(s)')
    // Closed by default — the summary is the whole row until asked otherwise.
    expect(details.attributes('open')).toBeUndefined()
    expect(details.find('pre').text()).toContain('"mode": "dark"')
  })

  it('gives array-of-object rows the same treatment, not a different one', async () => {
    // The two branches disagreeing about how to render the same value is what
    // pushed text out of the panel in the first place.
    const wrapper = await mountSuspended(ContentFieldDisplay, {
      props: { fieldId: 'f1', type: 'array', value: [{ label: 'Hero', config: { cols: 3, gap: 16 } }] },
    })

    const details = wrapper.find('details')
    expect(details.exists()).toBe(true)
    expect(details.find('summary').text()).toContain('2 field(s)')
  })

  it('counts array values as items rather than fields', async () => {
    const wrapper = await mountSuspended(ContentFieldDisplay, {
      props: { fieldId: 'f1', type: 'object', value: { tags: ['a', 'b', 'c'] } },
    })

    expect(wrapper.find('summary').text()).toContain('3 item(s)')
  })

  it('wraps the expanded block instead of scrolling it sideways', async () => {
    const wrapper = await mountSuspended(ContentFieldDisplay, {
      props: { fieldId: 'f1', type: 'object', value: { nested: { token: LONG_TOKEN } } },
    })

    const classes = wrapper.find('pre').classes()
    expect(classes).toContain('whitespace-pre-wrap')
    expect(classes).toContain('break-all')
    expect(classes).not.toContain('overflow-x-auto')
  })

  it('leaves plain values alone', async () => {
    const wrapper = await mountSuspended(ContentFieldDisplay, {
      props: { fieldId: 'f1', type: 'object', value: { title: 'Ana sayfa' } },
    })

    expect(wrapper.find('details').exists()).toBe(false)
    expect(wrapper.text()).toContain('Ana sayfa')
  })

  it('renders a null member as text rather than an empty disclosure', async () => {
    // typeof null === 'object' — the guard that is easy to forget.
    const wrapper = await mountSuspended(ContentFieldDisplay, {
      props: { fieldId: 'f1', type: 'object', value: { subtitle: null } },
    })

    expect(wrapper.find('details').exists()).toBe(false)
    expect(wrapper.text()).toContain('null')
  })

  it('keeps a long unbroken string inside the panel', async () => {
    const wrapper = await mountSuspended(ContentFieldDisplay, {
      props: { fieldId: 'f1', type: 'slug', value: LONG_TOKEN },
    })

    // `slug` falls through to the default branch, which had no protection.
    const classes = wrapper.find('span:last-child').classes()
    expect(classes).toContain('break-words')
  })

  it('makes the URL truncation actually apply', async () => {
    const wrapper = await mountSuspended(ContentFieldDisplay, {
      props: { fieldId: 'f1', type: 'url', value: `https://example.com/${LONG_TOKEN}` },
    })

    // truncate relies on overflow, which inline boxes ignore.
    const classes = wrapper.find('span').classes()
    expect(classes).toContain('truncate')
    expect(classes).toContain('block')
  })
})

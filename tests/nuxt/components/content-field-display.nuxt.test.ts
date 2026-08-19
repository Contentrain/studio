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

function mountMedia(type: string, value: unknown) {
  return mountSuspended(ContentFieldDisplay, { props: { type, value, fieldId: 'cover' } })
}

describe('ContentFieldDisplay media fields', () => {
  it('gives an image a preview trigger rather than a bare thumbnail', async () => {
    const wrapper = await mountMedia('image', 'media/8d2ed576-57e5-4cab-8f57-bfe52d56ddff.webp')

    const trigger = wrapper.find('button[aria-label="Show preview"]')
    expect(trigger.exists()).toBe(true)
    expect(trigger.find('img').exists()).toBe(true)
  })

  it('names a storage UUID by its kind instead of printing it whole', async () => {
    const wrapper = await mountMedia('image', 'media/8d2ed576-57e5-4cab-8f57-bfe52d56ddff.webp')

    expect(wrapper.text()).toContain('WEBP · 8d2ed576')
    expect(wrapper.text()).not.toContain('57e5-4cab')
  })

  it('renders a video as media, not as raw text', async () => {
    // `video` and `file` used to fall through to the URL branch, which printed
    // the path as a blue string and nothing else.
    const wrapper = await mountMedia('video', 'media/8d2ed576-57e5-4cab-8f57-bfe52d56ddff.mp4')

    expect(wrapper.find('button[aria-label="Show preview"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('MP4 · 8d2ed576')
  })

  it('gives a file a tile but no preview — there is nothing to show', async () => {
    const wrapper = await mountMedia('file', 'media/8d2ed576-57e5-4cab-8f57-bfe52d56ddff.pdf')

    expect(wrapper.find('button[aria-label="Show preview"]').exists()).toBe(false)
    expect(wrapper.text()).toContain('PDF · 8d2ed576')
  })

  it('marks a value that was never a stored asset as such, and does not fetch it', async () => {
    // The actual complaint: this looked exactly like a corrupt asset.
    const wrapper = await mountMedia('image', 'hero-image')

    expect(wrapper.text()).toContain('Not a stored asset')
    expect(wrapper.text()).not.toContain('could not be loaded')
    expect(wrapper.find('img').exists()).toBe(false)
  })

  it('reports a stored asset that fails to load as an error', async () => {
    const wrapper = await mountMedia('image', 'media/cover.webp')

    await wrapper.find('img').trigger('error')

    expect(wrapper.text()).toContain('could not be loaded')
    expect(wrapper.text()).not.toContain('Not a stored asset')
  })

  it('clears the failure when the value changes', async () => {
    // The component is reused down a list; one broken asset must not paint the
    // rows after it red.
    const wrapper = await mountMedia('image', 'media/cover.webp')
    await wrapper.find('img').trigger('error')
    expect(wrapper.text()).toContain('could not be loaded')

    await wrapper.setProps({ value: 'media/other.webp' })

    expect(wrapper.text()).not.toContain('could not be loaded')
    expect(wrapper.find('button[aria-label="Show preview"]').exists()).toBe(true)
  })
})

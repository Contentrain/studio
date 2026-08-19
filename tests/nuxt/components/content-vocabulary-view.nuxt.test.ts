import { describe, expect, it } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import ContentVocabularyView from '../../../app/components/organisms/ContentVocabularyView.vue'

const props = {
  terms: [['brand', { tr: 'Collabers' }]] as [string, Record<string, string>][],
  locale: 'tr',
  editable: true,
}

describe('ContentVocabularyView single entry', () => {
  it('returns focus to the key field after adding', async () => {
    // Terms are entered in runs; focus used to stay on the submit button, so
    // every term after the first needed a trip back to the mouse.
    const wrapper = await mountSuspended(ContentVocabularyView, { props, attachTo: document.body })

    const [key, value] = wrapper.findAll('input')
    await key!.setValue('creator')
    await value!.setValue('içerik üretici')
    await wrapper.find('form').trigger('submit')

    expect(wrapper.emitted('save')?.[0]?.[0]).toEqual({ creator: { tr: 'içerik üretici' } })
    expect(document.activeElement).toBe(key!.element)
  })

  it('lets the value field shrink so the button stays in the panel', async () => {
    const wrapper = await mountSuspended(ContentVocabularyView, { props })

    // A flex item defaults to min-width:auto, which kept a text input at its
    // intrinsic width and pushed the submit button past the panel edge.
    expect(wrapper.findAll('input')[1]!.classes()).toContain('min-w-0')
  })
})

describe('ContentVocabularyView bulk add', () => {
  async function openBulk() {
    const wrapper = await mountSuspended(ContentVocabularyView, { props })
    await wrapper.findAll('button').find(b => b.text().includes('Bulk add'))!.trigger('click')
    return wrapper
  }

  it('parses a tab-separated paste into one save', async () => {
    const wrapper = await openBulk()

    await wrapper.find('textarea').setValue('brand\tCollabers\ncreator\tİçerik üretici')
    await wrapper.find('form').trigger('submit')

    // One emit, not one per term — per-term saves would open a branch and a
    // merge each, which is what made vocabulary writes race in the first place.
    expect(wrapper.emitted('save')).toHaveLength(1)
    expect(wrapper.emitted('save')?.[0]?.[0]).toEqual({
      brand: { tr: 'Collabers' },
      creator: { tr: 'İçerik üretici' },
    })
  })

  it('accepts a hand-typed list separated by spaces', async () => {
    const wrapper = await openBulk()

    await wrapper.find('textarea').setValue('brand Collabers')
    await wrapper.find('form').trigger('submit')

    expect(wrapper.emitted('save')?.[0]?.[0]).toEqual({ brand: { tr: 'Collabers' } })
  })

  it('keeps the rest of the line as the translation', async () => {
    const wrapper = await openBulk()

    await wrapper.find('textarea').setValue('page-title\tAna sayfa başlığı')
    await wrapper.find('form').trigger('submit')

    expect(wrapper.emitted('save')?.[0]?.[0]).toEqual({ 'page-title': { tr: 'Ana sayfa başlığı' } })
  })

  it('skips blank lines and lines with no translation', async () => {
    const wrapper = await openBulk()

    await wrapper.find('textarea').setValue('brand\tCollabers\n\n   \nlonely-key\n')
    await wrapper.find('form').trigger('submit')

    expect(wrapper.emitted('save')?.[0]?.[0]).toEqual({ brand: { tr: 'Collabers' } })
  })

  it('counts what it found before anything is sent', async () => {
    const wrapper = await openBulk()

    await wrapper.find('textarea').setValue('a\t1\nb\t2\nc\t3')

    expect(wrapper.text()).toContain('3 term(s) ready')
  })

  it('will not submit an empty paste', async () => {
    const wrapper = await openBulk()

    await wrapper.find('form').trigger('submit')

    expect(wrapper.emitted('save')).toBeUndefined()
  })

  it('goes back to the single-term form on cancel', async () => {
    const wrapper = await openBulk()
    expect(wrapper.find('textarea').exists()).toBe(true)

    await wrapper.findAll('button').find(b => b.text().includes('Cancel'))!.trigger('click')

    expect(wrapper.find('textarea').exists()).toBe(false)
    expect(wrapper.findAll('input').length).toBeGreaterThan(0)
  })
})

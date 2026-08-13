import { describe, expect, it } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import ContentFieldEditor from '../../../app/components/atoms/ContentFieldEditor.vue'

const base = { fieldId: 'f1', standalone: false }

describe('ContentFieldEditor composite fields', () => {
  it('edits an array of plain values written in the object form', async () => {
    // `items: 'string'` reached the chip editor and `items: { type: 'string' }`
    // did not — the same schema spelled two ways, two different outcomes. The
    // object form fell through to the placeholder and took every nested field
    // inside it out of reach.
    const wrapper = await mountSuspended(ContentFieldEditor, {
      props: { ...base, type: 'array', modelValue: ['alpha'], fieldDef: { type: 'array', items: { type: 'string' } } },
    })

    expect(wrapper.text()).toContain('alpha')
    expect(wrapper.text()).not.toContain('Edit complex structures via chat')
  })

  it('still edits the shorthand form the same way', async () => {
    const wrapper = await mountSuspended(ContentFieldEditor, {
      props: { ...base, type: 'array', modelValue: ['alpha'], fieldDef: { type: 'array', items: 'string' } },
    })

    expect(wrapper.text()).toContain('alpha')
  })

  it('says an object schema defines no fields instead of drawing an empty box', async () => {
    const wrapper = await mountSuspended(ContentFieldEditor, {
      props: { ...base, type: 'object', modelValue: {}, fieldDef: { type: 'object', fields: {} } },
    })

    expect(wrapper.text()).toContain('defines no fields')
  })

  it('says an array never described its items', async () => {
    const wrapper = await mountSuspended(ContentFieldEditor, {
      props: { ...base, type: 'array', modelValue: [], fieldDef: { type: 'array', items: { type: 'object' } } },
    })

    expect(wrapper.text()).toContain('doesn\'t say what an item looks like')
  })

  it('distinguishes a Studio limit from a schema gap', async () => {
    const wrapper = await mountSuspended(ContentFieldEditor, {
      props: {
        ...base,
        type: 'object',
        modelValue: {},
        depth: 2,
        fieldDef: { type: 'object', fields: { inner: { type: 'string' } } },
      },
    })

    // A fixable schema and a form limit used to show the identical hint, which
    // is why the field report concluded nothing composite was editable.
    expect(wrapper.text()).toContain('nests deeper')
    expect(wrapper.text()).not.toContain('defines no fields')
  })

  it('still renders a real nested object as a form', async () => {
    const wrapper = await mountSuspended(ContentFieldEditor, {
      props: {
        ...base,
        type: 'object',
        modelValue: { title: 'Hero' },
        fieldDef: { type: 'object', fields: { title: { type: 'string' } } },
      },
    })

    expect(wrapper.find('input').exists()).toBe(true)
    expect(wrapper.text()).not.toContain('nests deeper')
  })
})

describe('ContentFieldEditor relation ordering', () => {
  const relationProps = {
    ...base,
    type: 'relations',
    modelValue: ['a', 'b', 'c'],
    fieldDef: { type: 'relations', model: 'articles' },
    relatedEntries: [
      { value: 'a', label: 'Alpha' },
      { value: 'b', label: 'Beta' },
      { value: 'c', label: 'Gamma' },
    ],
  }

  it('moves a chip later with the forward arrow keys', async () => {
    const wrapper = await mountSuspended(ContentFieldEditor, { props: relationProps })

    await wrapper.findAll('[role="listitem"]')[0]!.trigger('keydown', { key: 'ArrowRight' })

    expect(wrapper.emitted('update:modelValue')?.[0]?.[0]).toEqual(['b', 'a', 'c'])
  })

  it('moves a chip earlier with the back arrow keys', async () => {
    const wrapper = await mountSuspended(ContentFieldEditor, { props: relationProps })

    await wrapper.findAll('[role="listitem"]')[2]!.trigger('keydown', { key: 'ArrowUp' })

    expect(wrapper.emitted('update:modelValue')?.[0]?.[0]).toEqual(['a', 'c', 'b'])
  })

  it('refuses to move past either end', async () => {
    const wrapper = await mountSuspended(ContentFieldEditor, { props: relationProps })
    const chips = wrapper.findAll('[role="listitem"]')

    await chips[0]!.trigger('keydown', { key: 'ArrowLeft' })
    await chips[2]!.trigger('keydown', { key: 'ArrowRight' })

    expect(wrapper.emitted('update:modelValue')).toBeUndefined()
  })

  it('leaves other keys to the browser', async () => {
    const wrapper = await mountSuspended(ContentFieldEditor, { props: relationProps })

    await wrapper.findAll('[role="listitem"]')[0]!.trigger('keydown', { key: 'Enter' })

    expect(wrapper.emitted('update:modelValue')).toBeUndefined()
  })

  it('reaches the keyboard as well as the pointer', async () => {
    const wrapper = await mountSuspended(ContentFieldEditor, { props: relationProps })
    const chip = wrapper.findAll('[role="listitem"]')[0]!

    // Drag alone would put reordering out of reach of a keyboard user.
    expect(chip.attributes('tabindex')).toBe('0')
    expect(chip.attributes('draggable')).toBe('true')
    expect(chip.attributes('aria-label')).toContain('1 of 3')
  })
})

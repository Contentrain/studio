import { describe, expect, it } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import ContentFieldEditor from '../../../app/components/atoms/ContentFieldEditor.vue'

const stubs = {
  AtomsFormSelect: {
    props: ['modelValue', 'options'],
    emits: ['update:modelValue'],
    template: `<select data-test="select" :value="modelValue" @change="$emit('update:modelValue', ($event.target).value)">
      <option v-for="o in options" :key="o.value" :value="o.value">{{ o.label }}</option>
    </select>`,
  },
  AtomsFormInput: {
    props: ['modelValue'],
    emits: ['update:modelValue'],
    template: `<input data-test="input" :value="modelValue" @input="$emit('update:modelValue', ($event.target).value)">`,
  },
  AtomsBaseButton: { template: '<button type="button"><slot /></button>' },
}

describe('ContentFieldEditor — relations', () => {
  it('single relation: shows the current ref and emits the picked ref (non-polymorphic)', async () => {
    const wrapper = await mountSuspended(ContentFieldEditor, {
      props: {
        type: 'relation',
        fieldId: 'author',
        fieldDef: { type: 'relation', model: 'team-members' },
        modelValue: 'id1',
        relatedEntries: [
          { value: 'id1', label: 'Ahmet' },
          { value: 'id2', label: 'Jane' },
        ],
        standalone: false,
      },
      global: { stubs },
    })

    const select = wrapper.get('[data-test="select"]')
    expect((select.element as HTMLSelectElement).value).toBe('id1')

    await select.setValue('id2')
    expect(wrapper.emitted('update:modelValue')?.at(-1)).toEqual(['id2'])
  })

  it('single relation: encodes/decodes polymorphic { model, ref } values', async () => {
    const wrapper = await mountSuspended(ContentFieldEditor, {
      props: {
        type: 'relation',
        fieldId: 'target',
        fieldDef: { type: 'relation', model: ['blog-post', 'page'] },
        modelValue: { model: 'blog-post', ref: 'getting-started' },
        relatedEntries: [
          { value: 'blog-post::getting-started', label: 'blog-post: Getting Started' },
          { value: 'page::about', label: 'page: About' },
        ],
        standalone: false,
      },
      global: { stubs },
    })

    const select = wrapper.get('[data-test="select"]')
    expect((select.element as HTMLSelectElement).value).toBe('blog-post::getting-started')

    await select.setValue('page::about')
    expect(wrapper.emitted('update:modelValue')?.at(-1)).toEqual([{ model: 'page', ref: 'about' }])
  })

  it('multi relations: appends the picked ref to the array and hides already-selected entries', async () => {
    const wrapper = await mountSuspended(ContentFieldEditor, {
      props: {
        type: 'relations',
        fieldId: 'tags',
        fieldDef: { type: 'relations', model: 'tags' },
        modelValue: ['t1'],
        relatedEntries: [
          { value: 't1', label: 'One' },
          { value: 't2', label: 'Two' },
        ],
        standalone: false,
      },
      global: { stubs },
    })

    // Only the not-yet-selected option remains in the add dropdown.
    const optionValues = wrapper.findAll('[data-test="select"] option').map(o => (o.element as HTMLOptionElement).value)
    expect(optionValues).toEqual(['t2'])

    await wrapper.get('[data-test="select"]').setValue('t2')
    expect(wrapper.emitted('update:modelValue')?.at(-1)).toEqual([['t1', 't2']])
  })

  it('multi relations: offers a manual entry fallback when the target has no loaded entries', async () => {
    const wrapper = await mountSuspended(ContentFieldEditor, {
      props: {
        type: 'relations',
        fieldId: 'tags',
        fieldDef: { type: 'relations', model: 'tags' },
        modelValue: [],
        relatedEntries: [],
        standalone: false,
      },
      global: { stubs },
    })

    // No select (no entries) — the manual ref input is shown instead.
    expect(wrapper.find('[data-test="select"]').exists()).toBe(false)
    await wrapper.get('[data-test="input"]').setValue('manual-ref')
    await wrapper.get('button').trigger('click')
    expect(wrapper.emitted('update:modelValue')?.at(-1)).toEqual([['manual-ref']])
  })
})

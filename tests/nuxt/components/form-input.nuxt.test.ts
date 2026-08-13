import { describe, expect, it } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import FormInput from '../../../app/components/atoms/FormInput.vue'

describe('FormInput clearable', () => {
  it('stays out of the way until the field has a value', async () => {
    const empty = await mountSuspended(FormInput, { props: { clearable: true, modelValue: '' } })
    expect(empty.find('button').exists()).toBe(false)

    const filled = await mountSuspended(FormInput, { props: { clearable: true, modelValue: 'türki' } })
    expect(filled.find('button').exists()).toBe(true)
  })

  it('is opt-in — an ordinary field never grows a clear button', async () => {
    const wrapper = await mountSuspended(FormInput, { props: { modelValue: 'türki' } })

    expect(wrapper.find('button').exists()).toBe(false)
  })

  it('emits an empty value and keeps focus in the field', async () => {
    const wrapper = await mountSuspended(FormInput, {
      props: { clearable: true, modelValue: 'türki' },
      attachTo: document.body,
    })

    await wrapper.find('button').trigger('click')

    expect(wrapper.emitted('update:modelValue')?.[0]).toEqual([''])
    // The button unmounts with the value, so focus would otherwise fall to <body>.
    expect(document.activeElement).toBe(wrapper.find('input').element)
  })

  it('hides the button on a disabled field', async () => {
    const wrapper = await mountSuspended(FormInput, {
      props: { clearable: true, modelValue: 'türki', disabled: true },
    })

    expect(wrapper.find('button').exists()).toBe(false)
  })

  it('carries a button type and a label from the dictionary', async () => {
    const wrapper = await mountSuspended(FormInput, { props: { clearable: true, modelValue: 'x' } })
    const button = wrapper.find('button')

    expect(button.attributes('type')).toBe('button')
    expect(button.attributes('aria-label')).toBe('Clear')
  })

  it('leaves room for the button so it never sits on the text', async () => {
    const wrapper = await mountSuspended(FormInput, { props: { clearable: true, modelValue: 'x' } })

    expect(wrapper.find('input').classes()).toContain('pr-9')
  })
})

import { describe, expect, it } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import SigninWithEmail from '../../../app/components/organisms/SigninWithEmail.vue'

describe('SigninWithEmail', () => {
  it('submits the typed email address and can emit provider selection', async () => {
    const wrapper = await mountSuspended(SigninWithEmail, {
      props: {
        loading: false,
        error: '',
        magicLinkSent: false,
        sentEmail: '',
      },
      global: {
        stubs: {
          AtomsHeadingText: {
            template: '<div><slot /></div>',
          },
          AtomsFormLabel: {
            template: '<label><slot /></label>',
          },
          AtomsFormInput: {
            props: ['modelValue'],
            emits: ['update:modelValue'],
            template: '<input data-test="email" :value="modelValue" @input="$emit(\'update:modelValue\', $event.target.value)">',
          },
          AtomsBaseButton: {
            props: ['disabled', 'type'],
            template: '<button :type="type || \'button\'" :disabled="disabled"><slot /></button>',
          },
          MoleculesProviderButtons: {
            emits: ['provider'],
            template: '<button data-test="provider" @click="$emit(\'provider\', \'google\')">Google</button>',
          },
          MoleculesAuthLink: {
            template: '<a><slot /></a>',
          },
        },
      },
    })

    await wrapper.get('[data-test="email"]').setValue('user@example.com')
    await wrapper.get('form').trigger('submit')
    await wrapper.get('[data-test="provider"]').trigger('click')

    expect(wrapper.emitted('submit')).toEqual([['user@example.com']])
    expect(wrapper.emitted('provider')).toEqual([['google']])
  })

  it('renders sent-state copy after the magic link succeeds', async () => {
    const wrapper = await mountSuspended(SigninWithEmail, {
      props: {
        loading: false,
        error: '',
        magicLinkSent: true,
        sentEmail: 'user@example.com',
      },
      global: {
        stubs: {
          AtomsHeadingText: {
            template: '<div><slot /></div>',
          },
          AtomsBaseButton: {
            props: ['disabled', 'type'],
            template: '<button :type="type || \'button\'" :disabled="disabled"><slot /></button>',
          },
          MoleculesAuthLink: {
            template: '<a><slot /></a>',
          },
        },
      },
    })

    expect(wrapper.text()).toContain('We sent a login link to')
    expect(wrapper.text()).toContain('user@example.com')
    expect(wrapper.text()).toContain('Try a different email')
  })
})

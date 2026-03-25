import { describe, expect, it } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import SigninWithProvider from '../../../app/components/organisms/SigninWithProvider.vue'

describe('SigninWithProvider', () => {
  it('renders translated auth copy and emits provider actions', async () => {
    const wrapper = await mountSuspended(SigninWithProvider, {
      global: {
        stubs: {
          AtomsHeadingText: {
            template: '<div><slot /></div>',
          },
          MoleculesProviderButtons: {
            emits: ['provider'],
            template: '<button data-test="provider" @click="$emit(\'provider\', \'github\')">GitHub</button>',
          },
          MoleculesEmailButton: {
            emits: ['click'],
            template: '<button data-test="email" @click="$emit(\'click\')">Email</button>',
          },
          MoleculesAuthLink: {
            template: '<a data-test="support-link"><slot /></a>',
          },
        },
      },
    })

    expect(wrapper.text()).toContain('Welcome back')
    expect(wrapper.text()).toContain('Sign in to your account')

    await wrapper.get('[data-test="provider"]').trigger('click')
    await wrapper.get('[data-test="email"]').trigger('click')

    expect(wrapper.emitted('provider')).toEqual([['github']])
    expect(wrapper.emitted('showEmail')).toHaveLength(1)
  })
})

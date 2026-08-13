import { describe, expect, it } from 'vitest'
import { computed } from 'vue'
import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import ChatInput from '../../../app/components/molecules/ChatInput.vue'

mockNuxtImport('useFeature', () => (_key: string) => computed(() => true))

const props = { workspaceId: 'ws-1', projectId: 'proj-1' }

describe('ChatInput', () => {
  it('carries the model picker inside the composer card', async () => {
    const wrapper = await mountSuspended(ChatInput, { props })

    // The picker moved out of the chat header, so the composer is the only
    // place a model can be chosen — it has to render here.
    const trigger = wrapper.find('[aria-label="AI model"]')
    expect(trigger.exists()).toBe(true)

    // One card wraps the textarea and the action strip together.
    const card = wrapper.find('.rounded-2xl')
    expect(card.exists()).toBe(true)
    expect(card.find('textarea').exists()).toBe(true)
    expect(card.find('[aria-label="AI model"]').exists()).toBe(true)
    expect(card.find('[aria-label="Send"]').exists()).toBe(true)
  })

  it('opens at roughly three lines rather than a single-line strip', async () => {
    const wrapper = await mountSuspended(ChatInput, { props })

    expect(wrapper.find('textarea').classes()).toContain('min-h-[4.5rem]')
  })

  it('sends on Enter and keeps Shift+Enter for newlines', async () => {
    const wrapper = await mountSuspended(ChatInput, { props })
    const textarea = wrapper.find('textarea')

    await textarea.setValue('ship it')
    await textarea.trigger('keydown', { key: 'Enter', shiftKey: true })
    expect(wrapper.emitted('send')).toBeUndefined()

    await textarea.trigger('keydown', { key: 'Enter' })
    expect(wrapper.emitted('send')?.[0]?.[0]).toBe('ship it')
  })

  it('refuses to send an empty message', async () => {
    const wrapper = await mountSuspended(ChatInput, { props })

    await wrapper.find('textarea').setValue('   ')
    await wrapper.find('textarea').trigger('keydown', { key: 'Enter' })

    expect(wrapper.emitted('send')).toBeUndefined()
  })

  it('swaps send for stop while the assistant is streaming', async () => {
    const wrapper = await mountSuspended(ChatInput, {
      props: { ...props, streaming: true },
    })

    expect(wrapper.find('[aria-label="Send"]').exists()).toBe(false)

    const stop = wrapper.find('[aria-label="Stop"]')
    expect(stop.exists()).toBe(true)
    await stop.trigger('click')
    expect(wrapper.emitted('stop')).toHaveLength(1)
  })

  it('gives every action-strip control an explicit button type', async () => {
    const wrapper = await mountSuspended(ChatInput, { props })

    for (const button of wrapper.findAll('button')) {
      expect(button.attributes('type')).toBeDefined()
    }
  })
})

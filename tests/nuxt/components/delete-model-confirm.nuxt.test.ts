import { afterEach, describe, expect, it, vi } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import ContentModelList from '../../../app/components/organisms/ContentModelList.vue'
import { sendChatPromptKey } from '../../../app/utils/injection-keys'

afterEach(() => {
  document.body.innerHTML = ''
})

describe('delete model', () => {
  it('sends nothing on one click; only the armed second click asks the agent', async () => {
    // Deleting a model is a chat prompt the agent runs at once — one stray
    // click on the trash icon took the model and all its content with it.
    const send = vi.fn()
    const wrapper = await mountSuspended(ContentModelList, {
      props: {
        models: [{ id: 'faq', name: 'FAQ', kind: 'collection', type: 'collection', fields: {}, domain: 'marketing', i18n: true }],
        content: {},
      },
      global: { provide: { [sendChatPromptKey as symbol]: send } },
      attachTo: document.body,
    })

    await wrapper.find('button[aria-label="Delete model"]').trigger('click')
    expect(send).not.toHaveBeenCalled()

    // Escape disarms: the trash icon is back and still sends nothing.
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await nextTick()
    expect(wrapper.find('[data-testid="delete-model-confirm"]').exists()).toBe(false)

    await wrapper.find('button[aria-label="Delete model"]').trigger('click')
    await wrapper.find('[data-testid="delete-model-confirm"]').trigger('click')
    expect(send).toHaveBeenCalledOnce()
    expect(send).toHaveBeenCalledWith('Delete the FAQ model (ID: faq) and all its content.')
    wrapper.unmount()
  })
})

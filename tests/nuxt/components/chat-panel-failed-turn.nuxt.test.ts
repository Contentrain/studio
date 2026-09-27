import { describe, expect, it, vi } from 'vitest'
import { computed } from 'vue'
import { flushPromises } from '@vue/test-utils'
import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import ChatPanel from '../../../app/components/organisms/ChatPanel.vue'

mockNuxtImport('useFeature', () => (_key: string) => computed(() => true))

function streamOf(lines: string[]) {
  let i = 0
  return {
    ok: true,
    body: {
      getReader: () => ({
        read: async () => (i < lines.length
          ? { done: false, value: new TextEncoder().encode(lines[i++]) }
          : { done: true, value: undefined }),
      }),
    },
  }
}

describe('ChatPanel — a failed turn', () => {
  it('shows the error under the question and sends it again on Retry', async () => {
    vi.stubGlobal('$fetch', vi.fn().mockResolvedValue([]))
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 503, json: () => Promise.reject(new Error('html')) })
      .mockResolvedValueOnce(streamOf([
        'data: {"type":"text","content":"Done"}\n',
        'data: {"type":"done","affected":{"models":[],"locales":[],"snapshotChanged":false,"branchesChanged":false}}\n',
      ]))
    vi.stubGlobal('fetch', fetchMock)

    const wrapper = await mountSuspended(ChatPanel, {
      props: { workspaceId: 'ws-1', projectId: 'proj-1', projectName: 'Site', projectStatus: 'active' },
    })
    await (wrapper.vm as unknown as { handleSend: (text: string) => Promise<void> }).handleSend('Change the tagline')
    await flushPromises()

    const alert = wrapper.find('[data-testid="chat-failed-turn"]')
    expect(alert.exists()).toBe(true)
    expect(alert.attributes('role')).toBe('alert')
    expect(alert.text()).toContain('Retry')

    await alert.find('button').trigger('click')
    await flushPromises()

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(wrapper.find('[data-testid="chat-failed-turn"]').exists()).toBe(false)
    expect(wrapper.text()).toContain('Done')
    // The question shows once, not once per attempt.
    expect(wrapper.text().split('Change the tagline')).toHaveLength(2)
  })
})

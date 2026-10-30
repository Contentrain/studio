import { afterEach, describe, expect, it } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import ContentPanel from '../../../app/components/organisms/ContentPanel.vue'
import type { BrainSyncAccess } from '../../../shared/utils/content-access'

const model = (id: string, name: string) => ({ id, name, kind: 'singleton', type: 'singleton', fields: { title: { type: 'string' } }, domain: 'marketing', i18n: false })
const snapshot = {
  exists: true,
  config: { locales: { supported: ['en'], default: 'en' } },
  models: [model('hero', 'Hero'), model('footer', 'Footer')],
  content: {},
}

async function panelFor(access: BrainSyncAccess, activeModelId: string) {
  useState<BrainSyncAccess | null>('brain-access').value = access
  return mountSuspended(ContentPanel, {
    props: {
      snapshot,
      snapshotLoading: false,
      modelContent: { title: 'Ship it' },
      modelContentKind: 'singleton',
      modelContentLoading: false,
      activeModelId,
      workspaceId: 'ws-1',
      projectId: 'project-1',
    },
  })
}

const hasEdit = (wrapper: Awaited<ReturnType<typeof panelFor>>) =>
  wrapper.findAll('button').some(b => b.text().includes('Edit content'))

afterEach(() => {
  useState<BrainSyncAccess | null>('brain-access').value = null
})

describe('content panel write controls follow the role', () => {
  it('shows a viewer no Edit control', async () => {
    // A viewer saw Edit on every model and only met a 403 at save time.
    const wrapper = await panelFor({ availableTools: ['get_content', 'list_models'], specificModels: false, allowedModels: [] }, 'hero')
    expect(wrapper.text()).toContain('Ship it')
    expect(hasEdit(wrapper)).toBe(false)
  })

  it('shows an editor limited to some models Edit only on those', async () => {
    const editor: BrainSyncAccess = { availableTools: ['get_content', 'save_content'], specificModels: true, allowedModels: ['hero'] }
    expect(hasEdit(await panelFor(editor, 'hero'))).toBe(true)
    expect(hasEdit(await panelFor(editor, 'footer'))).toBe(false)
  })
})

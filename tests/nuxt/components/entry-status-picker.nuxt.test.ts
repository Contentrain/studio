import { describe, expect, it, vi } from 'vitest'
import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import EntryStatusPicker from '../../../app/components/molecules/EntryStatusPicker.vue'

const ownerOrAdmin = vi.hoisted(() => ({ value: false }))
mockNuxtImport('useWorkspaceRole', () => () => ({ isOwnerOrAdmin: computed(() => ownerOrAdmin.value) }))

async function mount(props: { status: string | null, schedule?: Record<string, string> | null, [key: string]: unknown }, { owner = false } = {}) {
  ownerOrAdmin.value = owner
  const wrapper = await mountSuspended(EntryStatusPicker, { props: { entryId: 'e1', editable: true, ...props } })
  return wrapper.find('[data-testid=entry-status-badge]')
}

describe('EntryStatusPicker schedule', () => {
  it('a published entry whose publish_at is still ahead reads as scheduled, with the date', async () => {
    const badge = await mount({ status: 'published', schedule: { publish_at: '2030-01-05T09:00:00.000Z' } })
    expect(badge.text()).toBe('scheduled')
    expect(badge.attributes('title')).toContain('goes live')
    expect(badge.attributes('title')).toContain('2030')
  })

  it('a published entry past its expire_at reads as expired', async () => {
    const badge = await mount({ status: 'published', schedule: { expire_at: '2020-01-01T00:00:00.000Z' } })
    expect(badge.text()).toBe('expired')
    expect(badge.attributes('title')).toContain('stopped being served')
  })

  it('inside its window, a published entry reads as published', async () => {
    const badge = await mount({ status: 'published', schedule: { publish_at: '2020-01-01T00:00:00.000Z', expire_at: '2099-01-01T00:00:00.000Z' } })
    expect(badge.text()).toBe('published')
    expect(badge.attributes('title')).toBeUndefined()
  })

  it('a draft stays a draft whatever its window says', async () => {
    const badge = await mount({ status: 'draft', schedule: { publish_at: '2030-01-05T09:00:00.000Z' } })
    expect(badge.text()).toBe('draft')
  })

  it('the owner\'s picker shows the scheduled phase on its trigger too', async () => {
    const badge = await mount({ status: 'published', schedule: { publish_at: '2030-01-05T09:00:00.000Z' }, workspaceId: 'w', projectId: 'p', modelId: 'm' }, { owner: true })
    expect(badge.text()).toBe('scheduled')
    expect(badge.element.closest('button')?.getAttribute('title')).toContain('goes live')
  })
})

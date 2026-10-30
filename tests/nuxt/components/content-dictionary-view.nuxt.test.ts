import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import ContentDictionaryView from '../../../app/components/organisms/ContentDictionaryView.vue'

const brain = vi.hoisted(() => ({
  invalidate: vi.fn(),
  sync: vi.fn(),
  queryContent: vi.fn(),
}))

mockNuxtImport('useContentBrain', () => () => ({
  config: computed(() => ({ locales: { default: 'en', supported: ['en'] } })),
  models: computed(() => [{ id: 'ui-strings', kind: 'dictionary', i18n: true }]),
  treeSha: computed(() => 'sha-1'),
  queryContent: brain.queryContent,
  invalidate: brain.invalidate,
  sync: brain.sync,
}))

const content = { 'a.one': 'One', 'b.count': 'You have {count} items', 'status': 'Live' }

async function openEditAll() {
  const wrapper = await mountSuspended(ContentDictionaryView, {
    props: { content, workspaceId: 'ws-1', projectId: 'p-1', modelId: 'ui-strings', locale: 'en', editable: true },
    attachTo: document.body,
  })
  await wrapper.find('[data-testid="dictionary-edit-all"]').trigger('click')
  await flushPromises()
  return wrapper
}

/** The modal is portalled to `body`; its inputs follow the key order. */
function dialogInput(key: string): HTMLInputElement {
  const dialog = document.body.querySelector('[role="dialog"]')!
  const index = Object.keys(content).indexOf(key)
  return dialog.querySelectorAll<HTMLInputElement>('input, textarea')[index]!
}

async function typeInto(key: string, value: string) {
  const input = dialogInput(key)
  input.value = value
  input.dispatchEvent(new Event('input'))
  await flushPromises()
}

async function save() {
  const button = [...document.body.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(b => b.textContent?.includes('Save changes'))!
  button.click()
  await flushPromises()
}

describe('ContentDictionaryView editing', () => {
  const fetchMock = vi.fn()

  beforeEach(() => {
    brain.invalidate.mockReset().mockResolvedValue(undefined)
    brain.sync.mockReset().mockResolvedValue(undefined)
    brain.queryContent.mockReset().mockResolvedValue({ data: null, kind: 'dictionary', meta: null })
    fetchMock.mockReset().mockResolvedValue({ branch: 'cr/content/ui-strings/en/1', merged: true, validation: { valid: true, errors: [] } })
    vi.stubGlobal('$fetch', fetchMock)
  })

  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('sends only the dirty keys, as the dictionary shape', async () => {
    await openEditAll()
    await typeInto('a.one', 'Uno')
    await save()

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, options] = fetchMock.mock.calls[0]!
    expect(url).toBe('/api/workspaces/ws-1/projects/p-1/content/ui-strings')
    expect(options.body).toEqual({ locale: 'en', data: { 'a.one': 'Uno' } })
  })

  it('edits a key named like a system field', async () => {
    // The form drops `status`, `id`, `source`… for entries; a dictionary key
    // with that name would have been impossible to edit.
    await openEditAll()
    await typeInto('status', 'Offline')
    await save()

    expect(fetchMock.mock.calls[0]![1].body.data).toEqual({ status: 'Offline' })
  })

  it('stays on the table and re-reads the content after a save', async () => {
    const wrapper = await openEditAll()
    await typeInto('a.one', 'Uno')
    await save()

    expect(brain.invalidate).toHaveBeenCalledWith('p-1')
    expect(brain.sync).toHaveBeenCalledWith('ws-1', 'p-1')
    expect(wrapper.emitted('saved')).toHaveLength(1)
    expect(wrapper.find('table').exists()).toBe(true)
  })

  it('warns when a value drops a placeholder, and still saves', async () => {
    await openEditAll()
    await typeInto('b.count', 'You have items')

    expect(document.body.querySelector('[data-testid="placeholder-warning"]')?.textContent).toContain('{count}')
    await save()
    expect(fetchMock.mock.calls[0]![1].body.data).toEqual({ 'b.count': 'You have items' })
  })

  async function mountView() {
    return mountSuspended(ContentDictionaryView, {
      props: { content, workspaceId: 'ws-1', projectId: 'p-1', modelId: 'ui-strings', locale: 'en', editable: true },
      attachTo: document.body,
    })
  }

  it('renames a key through the keys route and re-reads the content', async () => {
    const wrapper = await mountView()
    await wrapper.findAll('[data-testid="dictionary-rename-key"]')[0]!.trigger('click')
    await wrapper.find('[data-testid="dictionary-rename-form"] input').setValue('a.first')
    await wrapper.find('[data-testid="dictionary-rename-form"]').trigger('submit')
    await flushPromises()

    expect(fetchMock).toHaveBeenCalledWith('/api/workspaces/ws-1/projects/p-1/content/ui-strings/keys', {
      method: 'PATCH',
      body: { rename: { from: 'a.one', to: 'a.first' } },
    })
    expect(brain.sync).toHaveBeenCalledWith('ws-1', 'p-1')
  })

  it('deletes a key only after it is typed back', async () => {
    const wrapper = await mountView()
    await wrapper.findAll('[data-testid="dictionary-delete-key"]')[0]!.trigger('click')
    await flushPromises()
    const dialog = document.body.querySelector('[role="dialog"]')!
    const confirm = [...dialog.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent?.trim() === 'Delete')!
    expect(confirm.disabled).toBe(true)

    const input = dialog.querySelector<HTMLInputElement>('#confirm-delete-input')!
    input.value = 'a.one'
    input.dispatchEvent(new Event('input'))
    await flushPromises()
    confirm.click()
    await flushPromises()

    expect(fetchMock).toHaveBeenCalledWith('/api/workspaces/ws-1/projects/p-1/content/ui-strings/keys', {
      method: 'PATCH',
      body: { remove: ['a.one'] },
    })
  })
})

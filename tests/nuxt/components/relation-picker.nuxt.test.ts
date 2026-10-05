import { afterEach, describe, expect, it } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import { nextTick } from 'vue'
import ContentFieldEditor from '../../../app/components/atoms/ContentFieldEditor.vue'

const base = { fieldId: 'f1', standalone: false }

const entries = [
  { value: 'e1', label: 'İstanbul Guide' },
  { value: 'e2', label: 'Şehir Rehberi' },
  { value: 'e3', label: 'Plain title' },
]
const polymorphic = [
  { value: 'posts::p1', label: 'posts: Hello', group: 'posts', groupLabel: 'Blog posts', text: 'Hello' },
  { value: 'posts::p2', label: 'posts: Şiir', group: 'posts', groupLabel: 'Blog posts', text: 'Şiir' },
  { value: 'authors::a1', label: 'authors: Ada', group: 'authors', groupLabel: 'Authors', text: 'Ada' },
]

const wrappers: Array<{ unmount: () => void }> = []
afterEach(() => {
  while (wrappers.length) wrappers.pop()!.unmount()
})

type EditorProps = InstanceType<typeof ContentFieldEditor>['$props']

async function mountEditor(props: Omit<EditorProps, 'fieldId' | 'standalone'>) {
  const wrapper = await mountSuspended(ContentFieldEditor, { props: { ...base, ...props }, attachTo: document.body })
  wrappers.push(wrapper)
  return wrapper
}

const input = () => document.body.querySelector<HTMLInputElement>('input[role="combobox"]')!
const optionTexts = () => [...document.body.querySelectorAll('[role="option"]')].map(el => el.textContent?.replaceAll(/\s+/g, ' ').trim() ?? '')
// While searching, each row also shows the muted ref after the label.
const labelsOf = (refs: string[]) => optionTexts().map(t => refs.reduce((acc, r) => acc.endsWith(r) ? acc.slice(0, -r.length) : acc, t))

async function type(text: string) {
  const el = input()
  el.focus()
  el.value = text
  el.dispatchEvent(new Event('input', { bubbles: true }))
  await nextTick()
  await new Promise(r => setTimeout(r, 20))
}

async function key(k: string) {
  input().dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }))
  await nextTick()
  await new Promise(r => setTimeout(r, 20))
}

describe('relation picker', () => {
  it('is a labelled ARIA combobox, closed until used', async () => {
    await mountEditor({ type: 'relation', modelValue: '', fieldDef: { type: 'relation', model: 'articles' }, relatedEntries: entries })
    const el = input()
    expect(el).toBeTruthy()
    expect(el.getAttribute('aria-label')).toBeTruthy()
    expect(el.getAttribute('aria-expanded')).toBe('false')
    expect(document.body.querySelector('[role="listbox"]')).toBeNull()
  })

  it('opens on typing and narrows by label, ignoring case and Turkish diacritics', async () => {
    await mountEditor({ type: 'relation', modelValue: '', fieldDef: { type: 'relation', model: 'articles' }, relatedEntries: entries })
    await type('istanbul')
    expect(labelsOf(['e1'])).toEqual(['İstanbul Guide'])
    await type('SEHIR')
    expect(labelsOf(['e2'])).toEqual(['Şehir Rehberi'])
  })

  it('says so when nothing matches, and when there is nothing to choose from', async () => {
    await mountEditor({ type: 'relation', modelValue: '', fieldDef: { type: 'relation', model: 'articles' }, relatedEntries: entries })
    await type('zzz')
    expect(document.body.textContent).toContain('No entries match')
    expect(document.body.textContent).toContain('zzz')
  })

  it('shows a loading state while the entries are read', async () => {
    await mountEditor({ type: 'relation', modelValue: '', fieldDef: { type: 'relation', model: 'articles' }, relatedLoading: true })
    expect(input().getAttribute('aria-busy')).toBe('true')
  })

  it('picks with the keyboard: arrows move, Enter chooses, and the stored value is the ref', async () => {
    const wrapper = await mountEditor({ type: 'relation', modelValue: '', fieldDef: { type: 'relation', model: 'articles' }, relatedEntries: entries })
    await type('i')
    expect(optionTexts().length).toBeGreaterThan(1)
    await key('ArrowDown')
    await key('ArrowDown')
    await key('Enter')
    const emitted = wrapper.emitted('update:modelValue')
    expect(emitted).toBeTruthy()
    expect(['e1', 'e2', 'e3']).toContain(emitted!.at(-1)![0])
  })

  it('Escape closes the list', async () => {
    await mountEditor({ type: 'relation', modelValue: '', fieldDef: { type: 'relation', model: 'articles' }, relatedEntries: entries })
    await type('i')
    expect(document.body.querySelector('[role="listbox"]')).not.toBeNull()
    await key('Escape')
    expect(document.body.querySelector('[role="listbox"]')).toBeNull()
  })

  it('shows the chosen entry\'s label when closed', async () => {
    await mountEditor({ type: 'relation', modelValue: 'e2', fieldDef: { type: 'relation', model: 'articles' }, relatedEntries: entries })
    expect(input().value).toBe('Şehir Rehberi')
  })

  it('a filled-in field opens to the whole list, not only its own entry', async () => {
    await mountEditor({ type: 'relation', modelValue: 'e2', fieldDef: { type: 'relation', model: 'articles' }, relatedEntries: entries })
    input().click()
    await nextTick()
    await new Promise(r => setTimeout(r, 20))
    expect(optionTexts()).toHaveLength(3)
    await type('plain')
    expect(labelsOf(['e3'])).toEqual(['Plain title'])
  })

  it('shows the chosen entry once its entries arrive after the field is mounted', async () => {
    const wrapper = await mountEditor({ type: 'relation', modelValue: 'e2', fieldDef: { type: 'relation', model: 'articles' }, relatedLoading: true })
    expect(input().value).toBe('')
    await wrapper.setProps({ relatedLoading: false, relatedEntries: entries })
    await nextTick()
    await new Promise(r => setTimeout(r, 20))
    expect(input().value).toBe('Şehir Rehberi')
  })

  it('groups a polymorphic relation by model and shows the model name', async () => {
    await mountEditor({ type: 'relation', modelValue: null, fieldDef: { type: 'relation', model: ['posts', 'authors'] }, relatedEntries: polymorphic })
    await type('')
    input().click()
    await nextTick()
    await new Promise(r => setTimeout(r, 20))
    const text = document.body.textContent ?? ''
    expect(text).toContain('Blog posts')
    expect(text).toContain('Authors')
    expect(optionTexts()).toEqual(['Hello', 'Şiir', 'Ada'])
    await type('ada')
    expect(labelsOf(['a1'])).toEqual(['Ada'])
    expect(document.body.textContent).toContain('Authors')
  })

  it('caps a long list and asks for more typing', async () => {
    const many = Array.from({ length: 1500 }, (_, i) => ({ value: `id-${i}`, label: `Entry ${i}` }))
    await mountEditor({ type: 'relation', modelValue: '', fieldDef: { type: 'relation', model: 'articles' }, relatedEntries: many })
    await type('entry')
    expect(optionTexts().length).toBe(100)
    expect(document.body.textContent).toContain('Showing 100 of 1500')
    await type('entry 1499')
    expect(labelsOf(['id-1499'])).toEqual(['Entry 1499'])
    expect(document.body.textContent).not.toContain('Showing')
  })
})

describe('relations picker (add)', () => {
  const props = { type: 'relations', fieldDef: { type: 'relations', model: 'articles' }, relatedEntries: entries }

  it('hides what is already chosen, and adds the pick to the list', async () => {
    const wrapper = await mountEditor({ ...props, modelValue: ['e1'] })
    await type('')
    input().click()
    await nextTick()
    await new Promise(r => setTimeout(r, 20))
    expect(optionTexts()).toEqual(['Şehir Rehberi', 'Plain title'])
    await type('plain')
    await key('ArrowDown')
    await key('Enter')
    expect(wrapper.emitted('update:modelValue')!.at(-1)![0]).toEqual(['e1', 'e3'])
  })

  it('polymorphic add stores the { model, ref } compound', async () => {
    const wrapper = await mountEditor({ type: 'relations', modelValue: [], fieldDef: { type: 'relations', model: ['posts', 'authors'] }, relatedEntries: polymorphic })
    await type('ada')
    await key('ArrowDown')
    await key('Enter')
    expect(wrapper.emitted('update:modelValue')!.at(-1)![0]).toEqual([{ model: 'authors', ref: 'a1' }])
  })

  it('keeps the chips, with their drag handle and remove button', async () => {
    const wrapper = await mountEditor({ ...props, modelValue: ['e1', 'e2'] })
    expect(wrapper.findAll('[draggable="true"]')).toHaveLength(2)
    expect(wrapper.text()).toContain('İstanbul Guide')
  })

  it('still offers the manual id box when the target has no entries', async () => {
    const wrapper = await mountEditor({ ...props, modelValue: [], relatedEntries: [] })
    expect(document.body.querySelector('input[role="combobox"]')).toBeNull()
    expect(wrapper.find('input').exists()).toBe(true)
  })
})

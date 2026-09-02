import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mockNuxtImport } from '@nuxt/test-utils/runtime'
import { useContentEditor } from '../../../app/composables/useContentEditor'

const success = vi.fn()
const error = vi.fn()

mockNuxtImport('useToast', () => () => ({
  success,
  error,
}))

describe('useContentEditor', () => {
  beforeEach(() => {
    success.mockReset()
    error.mockReset()
  })

  it('saves inline field edits for collection entries', async () => {
    vi.stubGlobal('$fetch', vi.fn().mockResolvedValue({
      branch: 'cr/content/faq/en/1234567890-abcd',
      validation: { valid: true, errors: [] },
    }))

    const editor = useContentEditor()
    editor.startEdit('title', 'Old title')

    const result = await editor.saveField(
      'workspace-1',
      'project-1',
      'faq',
      'en',
      'entry-1',
      'title',
      'New title',
    )

    expect(result).toBe(true)
    expect(success).toHaveBeenCalledWith('Saved to branch: cr/content/faq/en/1234567890-abcd')
    expect(editor.isEditing.value).toBe(false)
    expect(editor.saveError.value).toBeNull()
  })

  it('says which other locales a media value landed in', async () => {
    // The silent version of this is what let an editor swap a hero image in
    // `en` and wonder why the `tr` site had not changed.
    vi.stubGlobal('$fetch', vi.fn().mockResolvedValue({
      branch: 'cr/content/site-settings/en/1234567890-abcd',
      validation: { valid: true, errors: [] },
      sharedAcrossLocales: { fields: ['guides_band_background'], locales: ['tr'] },
    }))

    const editor = useContentEditor()
    editor.startBatchEdit({ guides_band_background: 'old.webp', title: 'x' })
    editor.updateBatchField('guides_band_background', 'new.webp')

    const result = await editor.saveBatch('workspace-1', 'project-1', 'site-settings', 'en')

    expect(result).toBe(true)
    expect(success).toHaveBeenCalledWith('Saved to branch: cr/content/site-settings/en/1234567890-abcd')
    expect(success).toHaveBeenCalledWith('Also applied to tr: guides_band_background')
  })

  it('keeps inline editing open when server validation fails', async () => {
    vi.stubGlobal('$fetch', vi.fn().mockResolvedValue({
      branch: '',
      validation: { valid: false, errors: [{ message: 'Title is required' }] },
    }))

    const editor = useContentEditor()
    editor.startEdit('title', '')

    const result = await editor.saveField(
      'workspace-1',
      'project-1',
      'faq',
      'en',
      undefined,
      'title',
      '',
    )

    expect(result).toBe(false)
    expect(editor.isEditing.value).toBe(true)
    expect(editor.saveError.value).toBe('Title is required')
  })

  it('tracks dirty batch fields and submits only changed values', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      branch: 'cr/content/faq/en/1234567890-efgh',
      validation: { valid: true, errors: [] },
    })
    vi.stubGlobal('$fetch', fetchMock)

    const editor = useContentEditor()
    editor.startBatchEdit({
      title: 'Old title',
      description: 'Old description',
    })

    editor.updateBatchField('title', 'New title')
    editor.updateBatchField('description', 'Old description')

    expect(editor.hasBatchChanges.value).toBe(true)
    expect(editor.dirtyFieldCount.value).toBe(1)

    const result = await editor.saveBatch(
      'workspace-1',
      'project-1',
      'faq',
      'en',
      'entry-1',
    )

    expect(result).toBe(true)
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/workspaces/workspace-1/projects/project-1/content/faq',
      {
        method: 'POST',
        body: {
          locale: 'en',
          data: {
            'entry-1': {
              title: 'New title',
            },
          },
        },
      },
    )
    expect(editor.isBatchEditing.value).toBe(false)
  })
})

import { describe, expect, it, vi } from 'vitest'
import { mockNuxtImport } from '@nuxt/test-utils/runtime'
import { useRelationLabels } from '../../../app/composables/useRelationLabels'

const queryContent = vi.hoisted(() => vi.fn())
// Created inside the factory so it is a real ref the composable can watch;
// `vi.hoisted` runs before Vue is importable.
const brainState = vi.hoisted(() => ({ treeSha: null as { value: string } | null }))

mockNuxtImport('useContentBrain', () => () => ({
  queryContent,
  treeSha: (brainState.treeSha ??= ref('sha-1')),
  config: computed(() => ({ locales: { default: 'tr', supported: ['tr', 'en'] } })),
  models: computed(() => [
    { id: 'authors', title_field: 'name', fields: { name: { type: 'string' } } },
    { id: 'categories', title_field: 'title', fields: { title: { type: 'string' } } },
  ]),
}))

const articles = {
  id: 'articles',
  fields: {
    title: { type: 'string' },
    author: { type: 'relation', model: 'authors' },
    header_categories: { type: 'relations', model: 'categories' },
  },
}

async function settle() {
  await new Promise(r => setTimeout(r, 0))
  await nextTick()
}

describe('useRelationLabels', () => {
  it('titles every relation field of the model by the declared title field of its target', async () => {
    queryContent.mockImplementation(async (modelId: string) => {
      if (modelId === 'authors') return { data: { '54fc50cee2b1': { name: 'Collabers Editörü' } }, kind: 'collection', meta: null }
      if (modelId === 'categories') return { data: { b2c3d4e5f6a7: { title: 'Platform Güncellemeleri' } }, kind: 'collection', meta: null }
      return { data: null, kind: 'collection', meta: null }
    })

    const { relationLabels } = useRelationLabels(ref(articles), ref('en'))
    await settle()

    expect(relationLabels.value).toEqual({
      author: { '54fc50cee2b1': 'Collabers Editörü' },
      header_categories: { b2c3d4e5f6a7: 'Platform Güncellemeleri' },
    })
  })

  it('reads a non-i18n target from the default locale when the active one is empty', async () => {
    queryContent.mockImplementation(async (modelId: string, locale: string) => {
      if (modelId === 'authors' && locale === 'tr') return { data: { '54fc50cee2b1': { name: 'Editör' } }, kind: 'collection', meta: null }
      return { data: null, kind: 'collection', meta: null }
    })

    const { relationLabels } = useRelationLabels(ref(articles), ref('en'))
    await settle()

    expect(relationLabels.value.author).toEqual({ '54fc50cee2b1': 'Editör' })
    expect(queryContent).toHaveBeenCalledWith('authors', 'en')
    expect(queryContent).toHaveBeenCalledWith('authors', 'tr')
  })

  it('reloads when the synced tree moves, so a renamed target shows its new title', async () => {
    let name = 'Before'
    queryContent.mockImplementation(async (modelId: string) =>
      modelId === 'authors'
        ? { data: { '54fc50cee2b1': { name } }, kind: 'collection', meta: null }
        : { data: null, kind: 'collection', meta: null })

    const { relationLabels } = useRelationLabels(ref(articles), ref('en'))
    await settle()
    expect(relationLabels.value.author?.['54fc50cee2b1']).toBe('Before')

    name = 'After'
    brainState.treeSha!.value = 'sha-2'
    await settle()

    expect(relationLabels.value.author?.['54fc50cee2b1']).toBe('After')
  })

  it('has nothing to say for a model without relation fields', async () => {
    queryContent.mockClear()
    const { relationLabels } = useRelationLabels(ref({ id: 'plain', fields: { title: { type: 'string' } } }), ref('en'))
    await settle()

    expect(relationLabels.value).toEqual({})
    expect(queryContent).not.toHaveBeenCalled()
  })
})
